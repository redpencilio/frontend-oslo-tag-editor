# oslo-tag-editor

> **Experimental project.** This is a proof-of-concept built to explore browser-side editing of OSLO tagged values stored in Sparx Enterprise Architect EAP files. It is not production software. The majority of the code was generated with [Claude Code](https://claude.ai/code) (Anthropic).

## What it does

`oslo-tag-editor` is a fully client-side browser tool for inspecting and editing [OSLO](https://data.vlaanderen.be/standaarden/) tagged values in Sparx Enterprise Architect `.eap` / `.mdb` files, without requiring Enterprise Architect to be installed.

- **Load** an EAP file via drag-and-drop or file picker — nothing leaves your browser
- **Browse** the package hierarchy in a collapsible sidebar tree
- **View all tagged values** across elements, attributes, and connectors in a filterable table
- **Edit** OSLO tags inline; long values (definitions, usage notes) are handled transparently via EA's `NOTE$ea_notes=` encoding
- **OSLO grid views** per entity type (Elements, Attributes, Connectors) with grouped, language-aware column headers (`label-nl`, `label-en`, …)
- **Export** pending edits as a `.sql` patch script suitable for Sparx EA's built-in SQL Editor

## Approach

EAP files are Microsoft Access (JET/MDB) databases. The tool reads them entirely in-memory using:

- **[mdb-reader](https://github.com/andipaetzold/mdb-reader)** — pure-JavaScript MDB parser that runs in the browser
- **[alasql](https://github.com/AlaSQL/alasql)** — in-memory SQL engine used to join and query the extracted table data

This approach is directly inspired by and modelled on the **OSLO-UML-Transformer** project (see [Attribution](#attribution) below), which uses the same `mdb-reader` + `alasql` combination in its Node.js extractor.

Key EA tables used:

| Table | Purpose |
|---|---|
| `t_package` | Package hierarchy |
| `t_object` | Elements (Class, DataType, Enumeration) and packages |
| `t_objectproperties` | Tagged values for elements and packages |
| `t_attribute` | Attributes of elements |
| `t_attributetag` | Tagged values for attributes |
| `t_connector` | Associations, aggregations, generalisations |
| `t_connectortag` | Tagged values for connectors |
| `t_taggedvalue` | Role-end tags (ASSOCIATION\_SOURCE / ASSOCIATION\_TARGET) |

## Prerequisites

- Node.js ≥ 20
- npm ≥ 10

## Installation

```sh
git clone <repository-url>
cd oslo-tag-editor
npm install
```

## Running

```sh
npm start
# → http://localhost:4200
```

## Building

```sh
npm run build   # production build → dist/
```

## Known limitations

- **Read-only file format.** `mdb-reader` is a read-only parser. Edits are tracked in memory and exported as a SQL patch script. Apply the script via Sparx EA → Tools → Database Builder → SQL Editor, or an Access-compatible tool such as `mdb-tools`.
- **Role-tag editing** (`t_taggedvalue`) is not yet implemented in the grid views.
- **Adding new tags** from the All Tags view is not yet implemented (marked with a `TODO` in the source).
- This tool has been tested against EA 14/15 JET-format files. EAPX (SQL Server) files are not supported.

## Attribution

The database reading approach, table schema knowledge, tag-value semantics (including the `NOTE$ea_notes=` encoding), and OSLO tag name conventions are derived from the **OSLO-UML-Transformer** project:

> **OSLO-UML-Transformer**  
> <https://github.com/Informatievlaanderen/OSLO-UML-Transformer>  
> Copyright (c) Informatie Vlaanderen  
> Licensed under the [MIT License](https://github.com/Informatievlaanderen/OSLO-UML-Transformer/blob/master/LICENSE)

Specifically, the following files from that project informed the implementation here:

- `packages/oslo-extractor-uml-ea/lib/AccessDbFileReader.ts` — mdb-reader + alasql query patterns
- `packages/oslo-extractor-uml-ea/lib/utils/assignTags.ts` — NOTE sentinel logic and tag assignment
- `packages/oslo-extractor-uml-ea/lib/enums/EaTable.ts` — EA table name constants
- `packages/oslo-converter-uml-ea/lib/enums/TagNames.ts` — OSLO tag name vocabulary

## License

MIT — see [LICENSE](./LICENSE).
