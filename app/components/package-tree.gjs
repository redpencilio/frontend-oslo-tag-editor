import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { service } from '@ember/service';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import { eq } from 'ember-truth-helpers';

export default class PackageTree extends Component {
  @service eaDatabase;

  // A Set of packageIds that are currently expanded.
  // Reassigned on each toggle so Glimmer tracks the change.
  @tracked expandedIds = new Set();

  // ── computed ───────────────────────────────────────────────────────────────

  /**
   * Walk the nested package tree and produce a flat array of visible nodes,
   * skipping children of collapsed parents.  Each item carries:
   *   { node, depth, hasChildren, isExpanded, indent }
   */
  get flatNodes() {
    if (!this.eaDatabase.isLoaded) return [];

    const expanded = this.expandedIds; // track dependency
    const result = [];

    const walk = (nodes, depth) => {
      for (const node of nodes) {
        const hasChildren = node.children?.length > 0;
        const isExpanded  = expanded.has(node.packageId);
        result.push({
          node,
          depth,
          hasChildren,
          isExpanded,
          // Pre-compute the indent style so the template stays expression-free
          indent: `padding-left: ${depth * 18 + 8}px`,
        });
        if (isExpanded && hasChildren) {
          walk(node.children, depth + 1);
        }
      }
    };

    walk(this.eaDatabase.getPackageTree(), 0);
    return result;
  }

  get isEmpty() {
    return this.eaDatabase.isLoaded && this.flatNodes.length === 0;
  }

  // ── actions ────────────────────────────────────────────────────────────────

  @action
  toggle(packageId, event) {
    event.stopPropagation();
    const next = new Set(this.expandedIds);
    if (next.has(packageId)) next.delete(packageId);
    else next.add(packageId);
    this.expandedIds = next;
  }

  @action
  select(packageId) {
    this.args.onSelect?.(packageId);
  }

  // ── template ───────────────────────────────────────────────────────────────

  <template>
    <aside class="pkg-sidebar">
      <div class="pkg-sidebar__header">
        <span>Packages</span>
        {{#if this.eaDatabase.isLoaded}}
          <span class="pkg-sidebar__count">{{this.flatNodes.length}}</span>
        {{/if}}
      </div>

      <div class="pkg-sidebar__body">
        {{#if this.eaDatabase.isLoaded}}
          {{#if this.isEmpty}}
            <p class="pkg-sidebar__empty">No packages found.</p>
          {{else}}
            <ul class="pkg-tree" role="tree">
              {{#each this.flatNodes as |item|}}
                <li
                  class="pkg-node {{if (eq item.node.packageId @selectedId) 'pkg-node--selected'}}"
                  role="treeitem"
                  aria-expanded={{if item.hasChildren (if item.isExpanded "true" "false")}}
                  style={{item.indent}}
                >
                  {{! Expand / collapse toggle — only rendered when the node has children }}
                  {{#if item.hasChildren}}
                    <button
                      class="pkg-node__chevron"
                      type="button"
                      aria-label={{if item.isExpanded "Collapse" "Expand"}}
                      {{on "click" (fn this.toggle item.node.packageId)}}
                    >{{if item.isExpanded "▾" "▸"}}</button>
                  {{else}}
                    <span class="pkg-node__chevron pkg-node__chevron--leaf"></span>
                  {{/if}}

                  {{! Folder icon + name — clicking selects the package }}
                  <button
                    class="pkg-node__label"
                    type="button"
                    title={{item.node.name}}
                    {{on "click" (fn this.select item.node.packageId)}}
                  >
                    <span class="pkg-node__icon">{{if item.isExpanded "📂" "📁"}}</span>
                    <span class="pkg-node__name">{{item.node.name}}</span>
                  </button>
                </li>
              {{/each}}
            </ul>
          {{/if}}
        {{else}}
          <p class="pkg-sidebar__empty">Load an EAP file to browse packages.</p>
        {{/if}}
      </div>
    </aside>
  </template>
}
