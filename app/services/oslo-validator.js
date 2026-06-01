import Service from '@ember/service';
import { service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { TagNames, ValidStatuses, AllOsloTagNames } from 'oslo-tag-editor/oslo-tags';

// ── helpers ───────────────────────────────────────────────────────────────────

function isValidUrl(s) {
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function isPascalCase(s) { return /^[A-Z][a-zA-Z0-9]*$/.test(s); }
function isLowerCamelCase(s) { return /^[a-z][a-zA-Z0-9]*$/.test(s); }

function hasLeadingOrTrailingWhitespace(s) {
  return typeof s === 'string' && s !== s.trim();
}

const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };

// ── service ───────────────────────────────────────────────────────────────────

export default class OsloValidatorService extends Service {
  @service eaDatabase;

  @tracked results          = [];
  @tracked isValidated      = false;
  @tracked isRunning        = false;
  @tracked scopedPackageId   = null;   // null = all packages
  @tracked scopedPackageName = null;

  // ── public state ──────────────────────────────────────────────────────────

  get errorCount()   { return this.results.filter((r) => r.severity === 'error').length; }
  get warningCount() { return this.results.filter((r) => r.severity === 'warning').length; }
  get infoCount()    { return this.results.filter((r) => r.severity === 'info').length; }

  /**
   * Severity map for highlighting grid cells.
   * Key: `${table}::${elementId}::${tagName}` — matches the ea-database edit lookup format.
   * Value: highest severity for that cell.
   */
  get cellSeverityMap() {
    const map = new Map();
    for (const r of this.results) {
      if (!r.tagName || r.elementId == null || !r.table) continue;
      const key      = `${r.table}::${r.elementId}::${r.tagName}`;
      const existing = map.get(key);
      if (!existing || SEVERITY_RANK[r.severity] > SEVERITY_RANK[existing]) {
        map.set(key, r.severity);
      }
    }
    return map;
  }

  // ── main entry point ──────────────────────────────────────────────────────

  /**
   * @param {number|null} packageId  When set, validation is scoped to elements,
   *   attributes and connectors that belong to that package only.
   *   Pass null to validate the whole model.
   */
  async validate(packageId = null) {
    if (!this.eaDatabase.isLoaded) return [];

    // Record scope metadata and signal "busy" before any work starts
    this.isRunning         = true;
    this.scopedPackageId   = packageId;
    this.scopedPackageName = null;

    // Yield to the browser so Glimmer flushes the isRunning=true state and
    // re-renders the button as "Running…" before the synchronous work begins.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const out = [];
    const add = (severity, entity, message, extra = {}) =>
      out.push({ severity, entity, message, tagName: null, table: null, elementId: null, ...extra });

    // ── tag lookup maps (always full dataset — filtering is done per-entity) ──

    const objectTagRows  = this.eaDatabase.getAllObjectTags();
    const attrTagRows    = this.eaDatabase.getAllAttributeTags();
    const connTagRows    = this.eaDatabase.getAllConnectorTags();

    const objectTagsBy  = this.#groupBy(objectTagRows,  'objectId');
    const attrTagsBy    = this.#groupBy(attrTagRows,    'elementId');
    const connTagsBy    = this.#groupBy(connTagRows,    'connectorId');

    // ── scope filtering ────────────────────────────────────────────────────

    const allPackages  = this.eaDatabase.getAllPackagesFlat();
    const allElements  = this.eaDatabase.getAllElements();
    const allAttrs     = this.eaDatabase.getAllAttributes();
    const allConnectors = this.eaDatabase.getAllConnectors();

    // packageObjectIds is always the full set (needed to validate 'package' tag refs)
    const packageObjectIds = new Set(allPackages.map((p) => p.Object_ID).filter(Boolean));

    let packages, elements, attrs, connectors;

    if (packageId != null) {
      const scopePkg = allPackages.find((p) => p.Package_ID === packageId);
      this.scopedPackageName = scopePkg?.Name ?? `Package #${packageId}`;

      packages   = allPackages.filter((p) => p.Package_ID === packageId);
      elements   = allElements.filter((el) => el.Package_ID === packageId);

      const scopedElIds = new Set(elements.map((el) => el.Object_ID));
      attrs      = allAttrs.filter((a) => scopedElIds.has(a.Object_ID));
      connectors = allConnectors.filter(
        (c) => scopedElIds.has(c.Start_Object_ID) || scopedElIds.has(c.End_Object_ID),
      );
    } else {
      packages   = allPackages;
      elements   = allElements;
      attrs      = allAttrs;
      connectors = allConnectors;
    }

    // ── 1. Package validation ───────────────────────────────────────────────

    for (const pkg of packages) {
      const tags    = objectTagsBy.get(pkg.Object_ID) ?? [];
      const tagMap  = this.#tagValueMap(tags);
      const objCtx  = { table: 't_objectproperties', idColumn: 'Object_ID', elementId: pkg.Object_ID };

      this.#checkCommonTagIssues(tags, pkg.Name, 'package', objCtx, add);

      const baseUri = tagMap.get('baseURI');
      if (!baseUri) {
        add('error', pkg.Name, 'Missing required "baseURI" tag',
            { ...objCtx, tagName: 'baseURI', entityType: 'package' });
      } else if (!isValidUrl(baseUri)) {
        add('error', pkg.Name, `"baseURI" is not a valid URL: "${baseUri}"`,
            { ...objCtx, tagName: 'baseURI', entityType: 'package' });
      }

      if (!tagMap.has('baseURIabbrev')) {
        add('warning', pkg.Name, 'Missing recommended "baseURIabbrev" tag',
            { ...objCtx, tagName: 'baseURIabbrev', entityType: 'package' });
      }

      if (pkg.Name?.includes(' ')) {
        add('warning', pkg.Name, 'Package name contains spaces (may cause issues in URIs)',
            { entityType: 'package' });
      }
    }

    // ── 2. Element validation ───────────────────────────────────────────────

    for (const el of elements) {
      const tags   = objectTagsBy.get(el.Object_ID) ?? [];
      const tagMap = this.#tagValueMap(tags);
      const objCtx = { table: 't_objectproperties', idColumn: 'Object_ID', elementId: el.Object_ID };
      const entity = `${el.PackageName ? el.PackageName + ' / ' : ''}${el.Name}`;

      this.#checkCommonTagIssues(tags, entity, el.Object_Type.toLowerCase(), objCtx, add);

      if (!tagMap.get(TagNames.Label + '-nl')) {
        add('error', entity, 'Missing required "label-nl" tag',
            { ...objCtx, tagName: 'label-nl', entityType: el.Object_Type });
      }
      if (!tagMap.get(TagNames.Definition + '-nl')) {
        add('error', entity, 'Missing required "definition-nl" tag',
            { ...objCtx, tagName: 'definition-nl', entityType: el.Object_Type });
      }

      const uri = tagMap.get(TagNames.ExternalUri);
      if (uri && !isValidUrl(uri)) {
        add('error', entity, `"uri" is not a valid URL: "${uri}"`,
            { ...objCtx, tagName: 'uri', entityType: el.Object_Type });
      }

      const status = tagMap.get(TagNames.Status);
      if (status && !ValidStatuses.includes(status)) {
        add('error', entity, `"status" value is not a recognised OSLO status URI`,
            { ...objCtx, tagName: 'status', entityType: el.Object_Type });
      }

      if (el.Object_Type === 'Class' && !isPascalCase(el.Name)) {
        add('warning', entity, `Class name "${el.Name}" should be PascalCase`,
            { entityType: el.Object_Type });
      }

      if (el.Object_Type === 'Enumeration' && !tagMap.has(TagNames.ApCodelist)) {
        add('info', entity, 'Enumeration is missing recommended "ap-codelist" tag',
            { ...objCtx, tagName: 'ap-codelist', entityType: el.Object_Type });
      }

      const pkgTag = tagMap.get(TagNames.DefiningPackage);
      if (pkgTag) {
        const refObjId = parseInt(pkgTag, 10);
        if (!isNaN(refObjId) && !packageObjectIds.has(refObjId)) {
          add('warning', entity, `"package" tag references Object_ID ${refObjId} which is not a known package`,
              { ...objCtx, tagName: 'package', entityType: el.Object_Type });
        }
      }
    }

    // ── 3. Attribute validation ─────────────────────────────────────────────

    for (const attr of attrs) {
      const tags   = attrTagsBy.get(attr.ID) ?? [];
      const tagMap = this.#tagValueMap(tags);
      const atCtx  = { table: 't_attributetag', idColumn: 'ElementID', elementId: attr.ID };
      const entity = `${attr.ElementName} :: ${attr.Name}`;

      this.#checkCommonTagIssues(tags, entity, 'attribute', atCtx, add);

      if (!tagMap.get(TagNames.Label + '-nl')) {
        add('error', entity, 'Missing required "label-nl" tag',
            { ...atCtx, tagName: 'label-nl', entityType: 'attribute' });
      }
      if (!tagMap.get(TagNames.Definition + '-nl')) {
        add('error', entity, 'Missing required "definition-nl" tag',
            { ...atCtx, tagName: 'definition-nl', entityType: 'attribute' });
      }

      if (!isLowerCamelCase(attr.Name)) {
        add('warning', entity, `Attribute name "${attr.Name}" should be lowerCamelCase`,
            { entityType: 'attribute' });
      }

      const uri = tagMap.get(TagNames.ExternalUri);
      if (uri && !isValidUrl(uri)) {
        add('error', entity, `"uri" is not a valid URL: "${uri}"`,
            { ...atCtx, tagName: 'uri', entityType: 'attribute' });
      }
    }

    // ── 4. Connector validation ─────────────────────────────────────────────

    for (const conn of connectors) {
      const tags    = connTagsBy.get(conn.Connector_ID) ?? [];
      const tagMap  = this.#tagValueMap(tags);
      const connCtx = { table: 't_connectortag', idColumn: 'ElementID', elementId: conn.Connector_ID };
      const dispName = conn.Name || `${conn.SourceName} → ${conn.DestName}`;
      const entity   = dispName;

      if (conn.Connector_Type === 'Generalization') continue; // no tags needed

      // Endpoints must be valid element types
      const validTypes = ['Class', 'DataType', 'Enumeration'];
      if (!validTypes.includes(conn.SourceType) || !validTypes.includes(conn.DestType)) {
        add('warning', entity, `Connector endpoints include non-OSLO types (${conn.SourceType}, ${conn.DestType})`,
            { entityType: conn.Connector_Type });
      }

      this.#checkCommonTagIssues(tags, entity, conn.Connector_Type.toLowerCase(), connCtx, add);

      if (!tagMap.get(TagNames.Label + '-nl')) {
        add('error', entity, 'Missing required "label-nl" tag',
            { ...connCtx, tagName: 'label-nl', entityType: conn.Connector_Type });
      }
      if (!tagMap.get(TagNames.Definition + '-nl')) {
        add('error', entity, 'Missing required "definition-nl" tag',
            { ...connCtx, tagName: 'definition-nl', entityType: conn.Connector_Type });
      }

      const uri = tagMap.get(TagNames.ExternalUri);
      if (uri && !isValidUrl(uri)) {
        add('error', entity, `"uri" is not a valid URL: "${uri}"`,
            { ...connCtx, tagName: 'uri', entityType: conn.Connector_Type });
      }

      if (conn.Name && !isPascalCase(conn.Name) && !isLowerCamelCase(conn.Name)) {
        add('info', entity, `Connector name "${conn.Name}" is not PascalCase or lowerCamelCase`,
            { entityType: conn.Connector_Type });
      }
    }

    this.results    = out;
    this.isValidated = true;
    this.isRunning   = false;
    return out;
  }

  reset() {
    this.results           = [];
    this.isValidated       = false;
    this.scopedPackageId   = null;
    this.scopedPackageName = null;
  }

  // ── private helpers ───────────────────────────────────────────────────────

  /** Group an array of rows by a key field into a Map<key, rows[]>. */
  #groupBy(rows, keyField) {
    const map = new Map();
    for (const row of rows) {
      const k = row[keyField];
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
    return map;
  }

  /** Build a Map<tagName, tagValue> from a tag row array (first value wins per name). */
  #tagValueMap(rows) {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.tagName)) map.set(row.tagName, row.tagValue ?? '');
    }
    return map;
  }

  /**
   * Checks that apply to every tag list regardless of entity type:
   *  - NOTE sentinel with empty Notes (broken EA export)
   *  - Unknown tag names
   *  - Tags with leading / trailing whitespace in the value
   *  - Duplicate tag names on the same entity
   */
  #checkCommonTagIssues(tags, entity, entityType, ctx, add) {
    const counts = new Map();

    for (const tag of tags) {
      counts.set(tag.tagName, (counts.get(tag.tagName) ?? 0) + 1);

      // Broken NOTE export
      if (tag.rawValue === 'NOTE' && (!tag.rawNotes || tag.rawNotes === 'NOTE$ea_notes=')) {
        add('warning', entity, `Tag "${tag.tagName}" has NOTE sentinel but Notes column is empty (broken EA export)`,
            { ...ctx, tagName: tag.tagName, entityType });
      }

      // Unknown tag
      if (!AllOsloTagNames.has(tag.tagName)) {
        add('info', entity, `Unknown tag "${tag.tagName}" (not in the OSLO tag vocabulary)`,
            { ...ctx, tagName: tag.tagName, entityType });
      }

      // Whitespace in value
      if (hasLeadingOrTrailingWhitespace(tag.tagValue)) {
        add('warning', entity, `Tag "${tag.tagName}" value has leading or trailing whitespace`,
            { ...ctx, tagName: tag.tagName, entityType });
      }
    }

    // Duplicates
    for (const [name, count] of counts) {
      if (count > 1) {
        add('warning', entity, `Tag "${name}" appears ${count} times on the same element`,
            { ...ctx, tagName: name, entityType });
      }
    }
  }
}
