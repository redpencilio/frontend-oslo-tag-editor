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

    const edit = existing
      ? {
          type: 'update',
          table: tableName,
          propertyId: existing.PropertyID,
          idColumn,
          elementId,
          tagName,
          value,          // human-readable, for display
          storedValue,    // goes in Value / VALUE column
          storedNotes,    // goes in Notes / NOTES column
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
  save() {
    const lines = [
      '-- OSLO Tag Editor — SQL patch script',
      `-- Generated : ${new Date().toISOString()}`,
      `-- Source    : ${this.fileName}`,
      '--',
      '-- Apply with Sparx EA → Tools → Database Builder → SQL Editor,',
      '-- or an Access-compatible tool (mdb-tools, msaccess on Linux, etc.).',
      '-- Strings use single-quote escaping.  Review before applying.',
      '--',
      `-- Total changes: ${this.#edits.size}`,
      '',
    ];

    for (const edit of this.#edits.values()) {
      const v = this.#sqlStr(edit.storedValue);
      const n = this.#sqlStr(edit.storedNotes);

      if (edit.type === 'update') {
        lines.push(
          `UPDATE ${edit.table}` +
          ` SET ${edit.valueCol} = ${v}, ${edit.notesCol} = ${n}` +
          ` WHERE PropertyID = ${edit.propertyId};`,
        );
      } else {
        // INSERT — let Access auto-assign PropertyID (omit it)
        lines.push(
          `INSERT INTO ${edit.table} (${edit.idColumn}, Property, ${edit.valueCol}, ${edit.notesCol})` +
          ` VALUES (${edit.elementId}, '${this.#sqlEscape(edit.tagName)}', ${v}, ${n});`,
        );
      }
    }

    const script = lines.join('\n');
    const blob = new Blob([script], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `oslo-tag-patch-${Date.now()}.sql`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    return script;
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
