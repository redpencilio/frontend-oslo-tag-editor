import Service from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { Buffer } from 'buffer';
import MDBReader from 'mdb-reader';
import alasql from 'alasql';

// ── EA table names (mirrors EaTable enum in OSLO-UML-Transformer) ───────────
const TABLE = {
  Package:          't_package',
  Object:           't_object',          // elements AND packages share this table
  ObjectTag:        't_objectproperties', // ClassAndPackageTag — covers packages + elements
  Attribute:        't_attribute',
  AttributeTag:     't_attributetag',
  Connector:        't_connector',
  ConnectorTag:     't_connectortag',
  ConnectorRoleTag: 't_taggedvalue',      // role tags; ElementID = connector ea_guid
  Diagram:          't_diagram',
  DiagramObject:    't_diagramobjects',
  DiagramLink:      't_diagramlinks',
};

const EA_ELEMENT_TYPES = ['Class', 'DataType', 'Enumeration'];

// EA stores long tag values as NOTE sentinel in the Value column; the real
// value goes in Notes with this prefix.  See assignTags.ts / TagValues enum.
const NOTE_SENTINEL = 'NOTE';
const NOTE_PREFIX   = 'NOTE$ea_notes=';

// Per-table column schema for tag value storage (lowercase vs UPPERCASE varies by table).
const TAG_SCHEMA = {
  't_objectproperties': { valueCol: 'Value', notesCol: 'Notes', idCol: 'Object_ID' },
  't_attributetag':     { valueCol: 'VALUE', notesCol: 'NOTES', idCol: 'ElementID' },
  't_connectortag':     { valueCol: 'VALUE', notesCol: 'NOTES', idCol: 'ElementID' },
};

// ── service ──────────────────────────────────────────────────────────────────

export default class EaDatabaseService extends Service {
  @tracked isLoaded  = false;
  @tracked fileName  = null;
  @tracked error     = null;
  @tracked _editVersion = 0;  // bumped on every write; lets computed values re-run

  #tables     = new Map();  // tableName -> row[]
  #edits      = new Map();  // primary edit store  keyed by edit key
  #editLookup = new Map();  // secondary index     keyed by `${table}::${elementId}::${tagName}`
  #tempId     = -1;         // synthetic IDs for new tag inserts

  // ── public state ───────────────────────────────────────────────────────────

  get editCount() {
    this._editVersion;       // establish tracking dependency
    return this.#edits.size;
  }

  get tableNames() {
    return [...this.#tables.keys()];
  }

  // ── file loading ────────────────────────────────────────────────────────────

  async loadFile(file) {
    try {
      this.error    = null;
      this.isLoaded = false;
      this.#tables.clear();
      this.#edits.clear();
      this.#editLookup.clear();
      this._editVersion = 0;
      this.#tempId = -1;

      const arrayBuffer = await file.arrayBuffer();
      // mdb-reader uses Buffer.copy() internally — pass a polyfilled Buffer, not Uint8Array
      const buf = Buffer.from(arrayBuffer);
      const reader = new MDBReader(buf);

      const available = new Set(reader.getTableNames());
      for (const name of Object.values(TABLE)) {
        // Some EAP files omit certain tables; skip if absent. De-dup for aliases
        // (e.g. Object and ClassAndPackage both map to t_object).
        if (available.has(name) && !this.#tables.has(name)) {
          this.#tables.set(name, reader.getTable(name).getData());
        }
      }

      this.fileName = file.name;
      this.isLoaded = true;
    } catch (err) {
      this.error = err.message;
      console.error('[ea-database] loadFile failed:', err);
    }
  }

  // ── package queries ─────────────────────────────────────────────────────────

  /**
   * Returns a nested package tree.
   * Joins t_package → t_object on ea_guid (same as OSLO's loadPackages) to
   * obtain each package's Object_ID so tags can be looked up.
   *
   * Shape: { packageId, name, parentId, eaGuid, objectId, children[] }
   */
  getPackageTree() {
    const packages = this.#t(TABLE.Package);
    const objects  = this.#t(TABLE.Object);

    const sql = `
      SELECT p.Package_ID AS packageId,
             p.Name       AS name,
             p.Parent_ID  AS parentId,
             p.ea_guid    AS eaGuid,
             obj.Object_ID AS objectId
      FROM ? p
      LEFT JOIN ? obj ON p.ea_guid = obj.ea_guid`;

    const rows = this.#query(sql, [packages, objects]);
    return this.#buildTree(rows, 'packageId', 'parentId');
  }

  // ── flat tag query (for the tag editor view) ────────────────────────────────

  /**
   * Returns every row from t_objectproperties joined with its element and
   * package names.  The NOTE sentinel is resolved here so callers always get
   * a plain tagValue string.
   *
   * Shape: { propertyId, objectId, tagName, tagValue, elementName,
   *           elementType, packageId, packageName }
   */
  getAllObjectTags() {
    const props    = this.#t(TABLE.ObjectTag);  // t_objectproperties
    const objects  = this.#t(TABLE.Object);
    const packages = this.#t(TABLE.Package);

    const sql = `
      SELECT tp.PropertyID  AS propertyId,
             tp.Object_ID   AS objectId,
             tp.Property    AS tagName,
             tp.Value       AS rawValue,
             tp.Notes       AS rawNotes,
             obj.Name       AS elementName,
             obj.Object_Type AS elementType,
             obj.Package_ID  AS packageId,
             pkg.Name        AS packageName
      FROM ? tp
      LEFT JOIN ? obj ON tp.Object_ID  = obj.Object_ID
      LEFT JOIN ? pkg ON obj.Package_ID = pkg.Package_ID`;

    const rows = this.#query(sql, [props, objects, packages]);

    return rows.map((r) => ({
      ...r,
      // Apply NOTE sentinel: when rawValue === 'NOTE' the real text is in rawNotes
      tagValue:
        r.rawValue === NOTE_SENTINEL
          ? String(r.rawNotes ?? '').replace(NOTE_PREFIX, '')
          : (r.rawValue ?? ''),
    }));
  }

  /**
   * Returns every row from t_attributetag joined with attribute, element and package names.
   * t_attributetag uses uppercase VALUE / NOTES columns; NOTE sentinel is resolved.
   *
   * Shape: { propertyId, elementId (= attribute ID), tagName, tagValue,
   *           attributeName, elementName, elementType, packageId, packageName }
   */
  getAllAttributeTags() {
    const attrTags = this.#t(TABLE.AttributeTag);
    const attrs    = this.#t(TABLE.Attribute);
    const objects  = this.#t(TABLE.Object);
    const packages = this.#t(TABLE.Package);

    const sql = `
      SELECT at.PropertyID    AS propertyId,
             at.ElementID     AS elementId,
             at.Property      AS tagName,
             at.VALUE         AS rawValue,
             at.NOTES         AS rawNotes,
             a.Name           AS attributeName,
             obj.Name         AS elementName,
             obj.Object_Type  AS elementType,
             obj.Package_ID   AS packageId,
             pkg.Name         AS packageName
      FROM ? at
      INNER JOIN ? a   ON at.ElementID  = a.ID
      INNER JOIN ? obj ON a.Object_ID   = obj.Object_ID
      LEFT JOIN  ? pkg ON obj.Package_ID = pkg.Package_ID`;

    const rows = this.#query(sql, [attrTags, attrs, objects, packages]);

    return rows.map((r) => ({
      ...r,
      tagValue:
        r.rawValue === NOTE_SENTINEL
          ? String(r.rawNotes ?? '').replace(NOTE_PREFIX, '')
          : (r.rawValue ?? ''),
    }));
  }

  /**
   * Returns every row from t_connectortag joined with connector and endpoint names.
   * These are the regular per-connector tags (Property / VALUE / NOTES columns).
   * NOTE sentinel is resolved.
   *
   * Shape: { propertyId, connectorId, eaGuid, tagName, tagValue,
   *           connectorName, connectorType, sourceName, destName, packageId }
   */
  getAllConnectorTags() {
    const ctags      = this.#t(TABLE.ConnectorTag);  // t_connectortag
    const connectors = this.#t(TABLE.Connector);
    const objects    = this.#t(TABLE.Object);

    // t_connectortag uses uppercase VALUE / NOTES — normalise in SQL alias
    const sql = `
      SELECT ct.PropertyID        AS propertyId,
             ct.ElementID         AS connectorId,
             ct.Property          AS tagName,
             ct.VALUE             AS rawValue,
             ct.NOTES             AS rawNotes,
             c.ea_guid            AS eaGuid,
             c.Name               AS connectorName,
             c.Connector_Type     AS connectorType,
             c.Start_Object_ID    AS startObjectId,
             c.End_Object_ID      AS endObjectId,
             src.Name             AS sourceName,
             dst.Name             AS destName,
             src.Package_ID       AS packageId
      FROM ? ct
      INNER JOIN ? c   ON ct.ElementID        = c.Connector_ID
      INNER JOIN ? src ON c.Start_Object_ID   = src.Object_ID
      INNER JOIN ? dst ON c.End_Object_ID     = dst.Object_ID`;

    const rows = this.#query(sql, [ctags, connectors, objects, objects]);

    return rows.map((r) => ({
      ...r,
      tagValue:
        r.rawValue === NOTE_SENTINEL
          ? String(r.rawNotes ?? '').replace(NOTE_PREFIX, '')
          : (r.rawValue ?? ''),
    }));
  }

  /**
   * Returns every row from t_taggedvalue where BaseClass is ASSOCIATION_SOURCE
   * or ASSOCIATION_TARGET, joined with the connector and its endpoints.
   * These are the role-end tags (e.g. source.label-nl, target.uri).
   *
   * Shape: { propertyId, eaGuid, tagName, tagValue, role,
   *           connectorName, connectorType, sourceName, destName, packageId }
   */
  getAllConnectorRoleTags() {
    const roleTags   = this.#t(TABLE.ConnectorRoleTag);  // t_taggedvalue
    const connectors = this.#t(TABLE.Connector);
    const objects    = this.#t(TABLE.Object);

    // In t_taggedvalue: ElementID = connector ea_guid (string), TagValue = tag name,
    // Notes = tag value (always; NOTE prefix stripped if present)
    const sql = `
      SELECT rv.PropertyID        AS propertyId,
             rv.ElementID         AS eaGuid,
             rv.BaseClass         AS role,
             rv.TagValue          AS tagName,
             rv.Notes             AS rawNotes,
             c.Name               AS connectorName,
             c.Connector_Type     AS connectorType,
             c.Start_Object_ID    AS startObjectId,
             c.End_Object_ID      AS endObjectId,
             src.Name             AS sourceName,
             dst.Name             AS destName,
             src.Package_ID       AS packageId
      FROM ? rv
      INNER JOIN ? c   ON rv.ElementID         = c.ea_guid
      INNER JOIN ? src ON c.Start_Object_ID    = src.Object_ID
      INNER JOIN ? dst ON c.End_Object_ID      = dst.Object_ID
      WHERE rv.BaseClass IN ('ASSOCIATION_SOURCE', 'ASSOCIATION_TARGET')`;

    const rows = this.#query(sql, [roleTags, connectors, objects, objects]);

    return rows.map((r) => ({
      ...r,
      // Role tags always use Notes as the value (no sentinel — strip prefix if present)
      tagValue: String(r.rawNotes ?? '').replace(NOTE_PREFIX, ''),
    }));
  }

  // ── element queries ─────────────────────────────────────────────────────────

  /**
   * Returns Class / DataType / Enumeration elements in the given package.
   * (Direct children only — not recursive into sub-packages.)
   */
  getElementsInPackage(packageId) {
    return this.#t(TABLE.Object).filter(
      (o) => o.Package_ID === packageId && EA_ELEMENT_TYPES.includes(o.Object_Type),
    );
  }

  /**
   * Returns attributes for the given element Object_IDs, with the parent
   * element name joined in.  Ordered by element then Pos.
   */
  getAttributesForElements(objectIds) {
    if (!objectIds.length) return [];
    const attrs   = this.#t(TABLE.Attribute);
    const objects = this.#t(TABLE.Object);

    const sql = `
      SELECT a.ID, a.Object_ID, a.Name, a.Type, a.Scope,
             a.Stereotype, a.Pos, a.ea_guid,
             obj.Name AS ElementName
      FROM ? a
      LEFT JOIN ? obj ON a.Object_ID = obj.Object_ID
      WHERE a.Object_ID IN (${objectIds.join(',')})
      ORDER BY a.Object_ID, a.Pos`;

    return this.#query(sql, [attrs, objects]);
  }

  /**
   * Connectors where at least one endpoint is an element in the given package,
   * filtered to connections between Class / DataType / Enumeration elements.
   * Source and destination names are joined in.
   */
  getConnectorsForPackage(packageId) {
    const objects = this.#t(TABLE.Object);
    const elementIds = objects
      .filter((o) => o.Package_ID === packageId && EA_ELEMENT_TYPES.includes(o.Object_Type))
      .map((o) => o.Object_ID);

    if (!elementIds.length) return [];

    const connectors = this.#t(TABLE.Connector);
    const idList = elementIds.join(',');

    const sql = `
      SELECT c.Connector_ID, c.Name, c.Direction, c.Notes, c.Connector_Type,
             c.SourceRole, c.DestRole,
             c.Start_Object_ID, c.End_Object_ID,
             c.PDATA1, c.ea_guid, c.SourceCard, c.DestCard,
             src.Name AS SourceName,
             dst.Name AS DestinationName
      FROM ? c
      INNER JOIN ? src ON c.Start_Object_ID = src.Object_ID
      INNER JOIN ? dst ON c.End_Object_ID   = dst.Object_ID
      WHERE (c.Start_Object_ID IN (${idList}) OR c.End_Object_ID IN (${idList}))
        AND src.Object_Type IN ('Class', 'DataType', 'Enumeration')
        AND dst.Object_Type IN ('Class', 'DataType', 'Enumeration')`;

    return this.#query(sql, [connectors, objects, objects]);
  }

  // ── tag queries ─────────────────────────────────────────────────────────────

  /**
   * Tags for elements / packages from t_objectproperties.
   * Returns Map<Object_ID, [{propertyId, tagName, tagValue}]>
   *
   * Handles the NOTE sentinel: when Value === 'NOTE', the real value is in
   * Notes with the prefix 'NOTE$ea_notes=' stripped.
   */
  getTagsForObjects(objectIds) {
    if (!objectIds.length) return new Map();
    const tags = this.#t(TABLE.ObjectTag).filter((t) => objectIds.includes(t.Object_ID));
    return this.#groupTags(tags, 'Object_ID', 'Value', 'Notes');
  }

  /**
   * Tags for attributes from t_attributetag.
   * Returns Map<AttributeID, [{propertyId, tagName, tagValue}]>
   *
   * t_attributetag uses uppercase VALUE / NOTES columns; normalised here.
   */
  getTagsForAttributes(attributeIds) {
    if (!attributeIds.length) return new Map();
    const tags = this.#t(TABLE.AttributeTag)
      .filter((t) => attributeIds.includes(t.ElementID))
      .map((t) => ({ ...t, Value: t.VALUE, Notes: t.NOTES })); // normalise columns
    return this.#groupTags(tags, 'ElementID', 'Value', 'Notes');
  }

  /**
   * Tags for connectors from t_connectortag.
   * Returns Map<ConnectorID, [{propertyId, tagName, tagValue}]>
   *
   * t_connectortag uses uppercase VALUE / NOTES columns; normalised here.
   */
  getTagsForConnectors(connectorIds) {
    if (!connectorIds.length) return new Map();
    const tags = this.#t(TABLE.ConnectorTag)
      .filter((t) => connectorIds.includes(t.ElementID))
      .map((t) => ({ ...t, Value: t.VALUE, Notes: t.NOTES }));
    return this.#groupTags(tags, 'ElementID', 'Value', 'Notes');
  }

  /**
   * Role-specific tags on connectors from t_taggedvalue.
   * Returns Map<connectorEaGuid, { source: [tag], target: [tag] }>
   *
   * In t_taggedvalue:
   *   - ElementID  = connector's ea_guid (a string)
   *   - BaseClass  = 'ASSOCIATION_SOURCE' | 'ASSOCIATION_TARGET'
   *   - TagValue   = tag name
   *   - Notes      = tag value (always; no NOTE sentinel check needed here)
   */
  getConnectorRoleTags(connectorEaGuids) {
    if (!connectorEaGuids.length) return new Map();
    const guidsSet = new Set(connectorEaGuids);

    const tags = this.#t(TABLE.ConnectorRoleTag).filter(
      (t) =>
        guidsSet.has(t.ElementID) &&
        (t.BaseClass === 'ASSOCIATION_SOURCE' || t.BaseClass === 'ASSOCIATION_TARGET'),
    );

    const result = new Map();
    for (const tag of tags) {
      if (!result.has(tag.ElementID)) {
        result.set(tag.ElementID, { source: [], target: [] });
      }
      const entry = result.get(tag.ElementID);
      const eaTag = {
        propertyId: tag.PropertyID,
        tagName:    tag.TagValue,
        // Role tags always store the real value in Notes; strip the prefix if present
        tagValue:   String(tag.Notes ?? '').replace(NOTE_PREFIX, ''),
      };
      if (tag.BaseClass === 'ASSOCIATION_SOURCE') entry.source.push(eaTag);
      else entry.target.push(eaTag);
    }
    return result;
  }

  // ── pending edits ───────────────────────────────────────────────────────────

  /**
   * Record an insert-or-update for a tag.
   *
   * @param {string} tableName   - 't_objectproperties' | 't_attributetag' | 't_connectortag'
   * @param {string} idColumn    - foreign-key column linking tag to its element
   * @param {number} elementId   - element's ID value
   * @param {string} tagName     - value of the Property column
   * @param {string} value       - new human-readable tag value (unencoded)
   */
  upsertTag(tableName, idColumn, elementId, tagName, value) {
    const schema = TAG_SCHEMA[tableName];
    if (!schema) {
      console.error('[ea-database] upsertTag: unknown table', tableName);
      return;
    }

    const tableData = this.#t(tableName);
    const existing  = tableData.find(
      (r) => r[idColumn] === elementId && r.Property === tagName,
    );

    const [storedValue, storedNotes] = this.#encodeTagValue(value);
    const lookupKey = `${tableName}::${elementId}::${tagName}`;

    // Capture original value now for use in export comments
    const originalValue = existing
      ? (existing[schema.valueCol] === NOTE_SENTINEL
          ? String(existing[schema.notesCol] ?? '').replace(NOTE_PREFIX, '')
          : (existing[schema.valueCol] ?? ''))
      : null;

    const edit = existing
      ? {
          type: 'update',
          table: tableName,
          propertyId: existing.PropertyID,
          idColumn,
          elementId,
          tagName,
          value,           // human-readable, for display
          originalValue,   // original value before edit, for export comments
          storedValue,     // goes in Value / VALUE column
          storedNotes,     // goes in Notes / NOTES column
          ...schema,
        }
      : {
          type: 'insert',
          table: tableName,
          propertyId: this.#tempId--,  // negative sentinel; excluded from SQL WHERE
          idColumn,
          elementId,
          tagName,
          value,
          originalValue: null,
          storedValue,
          storedNotes,
          ...schema,
        };

    const primaryKey = `${edit.type}::${tableName}::${edit.propertyId}`;
    this.#edits.set(primaryKey, edit);
    this.#editLookup.set(lookupKey, edit);
    this._editVersion++;
  }

  /**
   * Look up a pending edit for a specific element + tag.
   * Returns undefined if no edit is pending.
   */
  getPendingEdit(tableName, elementId, tagName) {
    this._editVersion;  // track dependency
    return this.#editLookup.get(`${tableName}::${elementId}::${tagName}`);
  }

  revertEdit(tableName, elementId, tagName) {
    const lookupKey  = `${tableName}::${elementId}::${tagName}`;
    const edit = this.#editLookup.get(lookupKey);
    if (!edit) return;

    const primaryKey = `${edit.type}::${tableName}::${edit.propertyId}`;
    this.#edits.delete(primaryKey);
    this.#editLookup.delete(lookupKey);
    this._editVersion++;
  }

  revertAll() {
    this.#edits.clear();
    this.#editLookup.clear();
    this._editVersion++;
  }

  /**
   * Generate a SQL patch script for all pending edits and trigger a download.
   * mdb-reader is read-only; this script must be applied in an Access-compatible
   * tool (e.g. Sparx EA's built-in SQL Editor via Tools → Database Builder →
   * SQL Editor, or mdb-tools / msaccess-vba on Windows).
   *
   * Returns the script text as a string.
   */
  /**
   * Generate a Microsoft Access-compatible SQL patch script for all pending
   * edits, download it, and return the script text.
   *
   * Statement dialect notes:
   *  - Strings: single-quoted, internal single-quotes doubled ('').
   *  - Long text (>255 chars) uses the NOTE sentinel so EA stores it in the
   *    Memo field: Value='NOTE', Notes='NOTE$ea_notes=<actual text>'.
   *  - PropertyID is an AutoNumber in all three tables; INSERTs omit it.
   *  - No transactions, no IF EXISTS — Access SQL does not support them.
   *    Run statements one table at a time and verify with the SELECTs below.
   */
  save() {
    const edits   = [...this.#edits.values()];
    const updates = edits.filter((e) => e.type === 'update');
    const inserts = edits.filter((e) => e.type === 'insert');

    const tables = ['t_objectproperties', 't_attributetag', 't_connectortag'];

    const now = new Date();

    const L = []; // output lines
    const line  = (s = '')  => L.push(s);
    const sep   = ()         => line('-- ' + '-'.repeat(72));
    const blank = ()         => line('');

    // ── header ────────────────────────────────────────────────────────────────
    sep();
    line('-- OSLO Tag Editor — SQL Patch Script');
    line('-- Microsoft Access (JET) dialect — compatible with Sparx EA 15');
    sep();
    line(`-- Generated : ${now.toISOString()}`);
    line(`-- Source    : ${this.fileName}`);
    line(`-- Changes   : ${updates.length} UPDATE${updates.length !== 1 ? 's' : ''}, ${inserts.length} INSERT${inserts.length !== 1 ? 's' : ''}`);
    blank();

    // ── how to apply in EA 15 ─────────────────────────────────────────────────
    sep();
    line('-- HOW TO APPLY IN SPARX ENTERPRISE ARCHITECT 15');
    sep();
    line('--');
    line('-- Option A — EA built-in SQL Editor (recommended):');
    line('--   1. Open your EAP file in Enterprise Architect 15.');
    line('--   2. Go to: Tools  →  Database Builder');
    line('--   3. In the Database Builder panel, click the "SQL" tab.');
    line('--   4. Paste the statements from ONE section below into the editor.');
    line('--      Run one table at a time; do NOT paste the entire file at once.');
    line('--   5. Click the green  ▶  Run button.');
    line('--   6. Confirm the row count shown in the results panel.');
    line('--   7. Repeat for each section.');
    line('--   8. Close and re-open any diagrams to see updated tag values.');
    line('--');
    line('-- Option B — Microsoft Access (if you have it installed):');
    line('--   1. Open the .eap file in Access (it is a standard JET/MDB database).');
    line('--   2. Go to: Create  →  Query Design, switch to SQL View.');
    line('--   3. Paste and run one section at a time as above.');
    line('--');
    line('-- Option C — mdb-tools (Linux / macOS):');
    line('--   mdb-sql path/to/file.eap < this_script.sql');
    line('--');
    line('-- IMPORTANT:');
    line('--   • Review every statement before running — verify element names');
    line('--     and tag names match your expectations.');
    line('--   • Back up your EAP file before applying any changes.');
    line('--   • EA caches tag values; restart EA after applying if values');
    line('--     do not appear updated in the UI.');
    line('--');

    // ── NOTE convention explanation ───────────────────────────────────────────
    sep();
    line('-- NOTE CONVENTION');
    sep();
    line('--');
    line('-- Sparx EA stores tag values longer than 255 characters using a two-');
    line('-- field convention:');
    line('--   Value = \'NOTE\'');
    line('--   Notes = \'NOTE$ea_notes=<actual text>\'');
    line('--');
    line('-- This script applies that convention automatically for long values.');
    line('-- Short values clear the Notes field (set to empty string).');
    line('--');

    // ── summary ───────────────────────────────────────────────────────────────
    if (edits.length === 0) {
      line('-- No pending edits — nothing to export.');
      const script = L.join('\n');
      this.#download(script, 'oslo-tag-patch');
      return script;
    }

    sep();
    line('-- CHANGE SUMMARY');
    sep();
    for (const table of tables) {
      const u = updates.filter((e) => e.table === table).length;
      const i = inserts.filter((e) => e.table === table).length;
      if (u + i > 0) line(`--   ${table.padEnd(22)} ${u} update${u !== 1 ? 's' : ''}, ${i} insert${i !== 1 ? 's' : ''}`);
    }
    blank();

    // ── statements, grouped by table then type ────────────────────────────────
    for (const table of tables) {
      const tableEdits = edits.filter((e) => e.table === table);
      if (!tableEdits.length) continue;

      const tableUpdates = tableEdits.filter((e) => e.type === 'update');
      const tableInserts = tableEdits.filter((e) => e.type === 'insert');

      sep();
      line(`-- TABLE: ${table}`);
      sep();
      blank();

      if (tableUpdates.length) {
        line(`-- ── UPDATEs (${tableUpdates.length}) ──`);
        blank();
        for (const edit of tableUpdates) {
          const ctx = this.#editContext(edit);
          line(`-- ${ctx}`);
          line(`-- Old value : ${this.#truncate(edit.originalValue ?? '(unknown)')}`);
          line(`-- New value : ${this.#truncate(edit.value)}`);
          if (edit.storedValue === NOTE_SENTINEL) {
            line('-- (stored as NOTE sentinel — value exceeds 255 chars)');
          }
          line(
            `UPDATE ${table}` +
            ` SET ${edit.valueCol} = ${this.#sqlStr(edit.storedValue)},` +
            ` ${edit.notesCol} = ${this.#sqlStr(edit.storedNotes)}` +
            ` WHERE PropertyID = ${edit.propertyId};`,
          );
          blank();
        }
      }

      if (tableInserts.length) {
        line(`-- ── INSERTs (${tableInserts.length}) ──`);
        line('-- PropertyID is omitted; Access assigns an AutoNumber automatically.');
        blank();
        for (const edit of tableInserts) {
          const ctx = this.#editContext(edit);
          line(`-- ${ctx}`);
          line(`-- Value : ${this.#truncate(edit.value)}`);
          if (edit.storedValue === NOTE_SENTINEL) {
            line('-- (stored as NOTE sentinel — value exceeds 255 chars)');
          }
          line(
            `INSERT INTO ${table}` +
            ` (${edit.idColumn}, Property, ${edit.valueCol}, ${edit.notesCol})` +
            ` VALUES (${edit.elementId}, ${this.#sqlStr(edit.tagName)},` +
            ` ${this.#sqlStr(edit.storedValue)}, ${this.#sqlStr(edit.storedNotes)});`,
          );
          blank();
        }
      }
    }

    // ── verification SELECTs ──────────────────────────────────────────────────
    sep();
    line('-- VERIFICATION');
    line('-- Run these SELECTs after applying the patch to confirm results.');
    sep();
    blank();

    for (const table of tables) {
      const tableUpdates = updates.filter((e) => e.table === table);
      const tableInserts = inserts.filter((e) => e.table === table);
      if (!tableUpdates.length && !tableInserts.length) continue;

      const schema = TAG_SCHEMA[table];

      line(`-- ${table}`);

      if (tableUpdates.length) {
        const ids = tableUpdates.map((e) => e.propertyId).join(', ');
        line(
          `SELECT PropertyID, ${schema.idCol}, Property,` +
          ` ${schema.valueCol}, ${schema.notesCol}` +
          ` FROM ${table} WHERE PropertyID IN (${ids});`,
        );
      }

      if (tableInserts.length) {
        // For inserts we don't know the assigned PropertyID; query by element+tag
        for (const edit of tableInserts) {
          line(
            `SELECT PropertyID, ${schema.idCol}, Property,` +
            ` ${schema.valueCol}, ${schema.notesCol}` +
            ` FROM ${table}` +
            ` WHERE ${schema.idCol} = ${edit.elementId}` +
            ` AND Property = ${this.#sqlStr(edit.tagName)};`,
          );
        }
      }

      blank();
    }

    sep();
    line('-- END OF SCRIPT');
    sep();

    const script = L.join('\n');
    this.#download(script, 'oslo-tag-patch');
    return script;
  }

  /** Trigger a file download. */
  #download(text, baseName) {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([text], { type: 'text/plain; charset=utf-8' });
    const a    = Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(blob),
      download: `${baseName}-${ts}.sql`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Build a short human-readable description of an edit for use in comments. */
  #editContext(edit) {
    // Look up element/attribute/connector name from the in-memory tables
    let subject = `ID=${edit.elementId}`;

    try {
      if (edit.table === 't_objectproperties') {
        const obj = this.#t(TABLE.Object).find((o) => o.Object_ID === edit.elementId);
        if (obj) subject = `${obj.Object_Type ?? 'Element'} "${obj.Name}"`;
      } else if (edit.table === 't_attributetag') {
        const attr = this.#t(TABLE.Attribute).find((a) => a.ID === edit.elementId);
        if (attr) {
          const obj = this.#t(TABLE.Object).find((o) => o.Object_ID === attr.Object_ID);
          subject = obj ? `Attribute "${attr.Name}" on "${obj.Name}"` : `Attribute "${attr.Name}"`;
        }
      } else if (edit.table === 't_connectortag') {
        const conn = this.#t(TABLE.Connector).find((c) => c.Connector_ID === edit.elementId);
        if (conn) {
          const src  = this.#t(TABLE.Object).find((o) => o.Object_ID === conn.Start_Object_ID);
          const dst  = this.#t(TABLE.Object).find((o) => o.Object_ID === conn.End_Object_ID);
          const name = conn.Name || `${src?.Name ?? '?'} → ${dst?.Name ?? '?'}`;
          subject = `Connector "${name}"`;
        }
      }
    } catch {
      // context lookup is best-effort
    }

    return `${edit.type.toUpperCase()} | ${subject} | tag: ${edit.tagName}`;
  }

  /** Truncate a string for use inside a comment. */
  #truncate(s, max = 80) {
    const str = String(s ?? '');
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  /** Safe table access; returns empty array if table was absent in the EAP. */
  #t(name) {
    return this.#tables.get(name) ?? [];
  }

  /** Run an alasql query, log errors and return [] instead of throwing. */
  #query(sql, params = []) {
    try {
      return alasql(sql, params) ?? [];
    } catch (err) {
      console.error('[ea-database] query error:', err.message, '\nSQL:', sql);
      return [];
    }
  }

  /**
   * Build a nested tree from a flat row array.
   * Rows with no valid parent (missing or ID not in the map) become roots.
   */
  #buildTree(rows, idKey, parentKey) {
    const map = new Map(rows.map((r) => [r[idKey], { ...r, children: [] }]));
    const roots = [];
    for (const node of map.values()) {
      const parentId = node[parentKey];
      if (parentId && map.has(parentId)) {
        map.get(parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * Group a normalised tag row array into a Map keyed by idCol.
   * Applies the NOTE sentinel: when Value === 'NOTE', real value is in Notes.
   */
  #groupTags(tags, idCol, valueCol, notesCol) {
    const result = new Map();
    for (const tag of tags) {
      const id = tag[idCol];
      if (!result.has(id)) result.set(id, []);

      const rawValue = tag[valueCol];
      const tagValue =
        rawValue === NOTE_SENTINEL
          ? String(tag[notesCol] ?? '').replace(NOTE_PREFIX, '')
          : (rawValue ?? '');

      result.get(id).push({
        propertyId: tag.PropertyID,
        tagName:    tag.Property,
        tagValue,
      });
    }
    return result;
  }

  /**
   * Encode a human-readable value for storage.
   * Values longer than 255 characters are stored as NOTE sentinel + prefixed Notes.
   * Returns [storedValue, storedNotes].
   */
  #encodeTagValue(value) {
    const s = String(value ?? '');
    if (s.length > 255) {
      return [NOTE_SENTINEL, NOTE_PREFIX + s];
    }
    return [s, ''];
  }

  /** Wrap a string in single quotes, with internal quotes doubled. */
  #sqlStr(s) {
    return `'${this.#sqlEscape(s)}'`;
  }

  #sqlEscape(s) {
    return String(s ?? '').replace(/'/g, "''");
  }
}
