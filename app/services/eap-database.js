import Service from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { Buffer } from 'buffer';
import MDBReader from 'mdb-reader';
import alasql from 'alasql';

// Tables from a Sparx Enterprise Architect MDB that we care about
const EA_TABLES = [
  't_taggedvalue',
  't_object',
  't_package',
  't_attribute',
  't_connector',
  't_operation',
];

export default class EapDatabaseService extends Service {
  @tracked isLoaded = false;
  @tracked fileName = null;
  @tracked error = null;
  @tracked tableNames = [];
  @tracked _editVersion = 0;

  #edits = new Map(); // Map<string(PropertyID), {Value?, Notes?}>

  get editCount() {
    // depend on _editVersion so getters that call this re-compute on edits
    this._editVersion;
    return this.#edits.size;
  }

  async loadFile(file) {
    try {
      this.error = null;
      this.isLoaded = false;
      this.#edits = new Map();
      this._editVersion = 0;

      const arrayBuffer = await file.arrayBuffer();
      // mdb-reader calls Buffer.copy() internally — pass a polyfilled Buffer, not a Uint8Array
      const buf = Buffer.from(arrayBuffer);
      const reader = new MDBReader(buf);

      const allTables = reader.getTableNames();
      this.tableNames = allTables;

      // Drop and re-create in case a previous file was loaded
      for (const name of EA_TABLES) {
        if (!allTables.includes(name)) continue;
        try {
          alasql(`DROP TABLE IF EXISTS \`${name}\``);
        } catch {
          // alasql may not support IF EXISTS on older builds
        }
        alasql(`CREATE TABLE \`${name}\``);
        alasql.tables[name].data = reader.getTable(name).getData();
      }

      this.fileName = file.name;
      this.isLoaded = true;
    } catch (err) {
      this.error = err.message;
      console.error('[eap-database] load failed:', err);
    }
  }

  // Run an alasql query against the in-memory tables.
  query(sql, params = []) {
    try {
      return alasql(sql, params);
    } catch (err) {
      console.error('[eap-database] query error:', err.message, '\nSQL:', sql);
      return [];
    }
  }

  applyEdit(propertyId, field, value) {
    const key = String(propertyId);
    const prev = this.#edits.get(key) ?? {};
    this.#edits.set(key, { ...prev, [field]: value });
    this._editVersion++;
  }

  revertEdit(propertyId) {
    this.#edits.delete(String(propertyId));
    this._editVersion++;
  }

  revertAll() {
    this.#edits.clear();
    this._editVersion++;
  }

  getEdit(propertyId) {
    this._editVersion;
    return this.#edits.get(String(propertyId));
  }

  // Returns array of {PropertyID, Property, ElementID, Value, Notes} for export
  exportEdits() {
    const rows = [];
    for (const [id, edit] of this.#edits) {
      rows.push({ PropertyID: id, ...edit });
    }
    return rows;
  }
}
