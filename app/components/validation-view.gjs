import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { service } from '@ember/service';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import { not, eq } from 'ember-truth-helpers';

const SEVERITIES = ['error', 'warning', 'info'];

export default class ValidationView extends Component {
  @service osloValidator;

  @tracked filterText     = '';
  @tracked filterSeverity = new Set(SEVERITIES);

  // ── computed ─────────────────────────────────────────────────────────────

  get results() { return this.osloValidator.results; }

  get filteredResults() {
    let rows = this.results;

    if (this.filterSeverity.size < SEVERITIES.length) {
      rows = rows.filter((r) => this.filterSeverity.has(r.severity));
    }

    if (this.filterText) {
      const q = this.filterText.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.entity  ?? '').toLowerCase().includes(q) ||
          (r.message ?? '').toLowerCase().includes(q) ||
          (r.tagName ?? '').toLowerCase().includes(q),
      );
    }

    return rows;
  }

  get errorCount()   { return this.osloValidator.errorCount; }
  get warningCount() { return this.osloValidator.warningCount; }
  get infoCount()    { return this.osloValidator.infoCount; }
  get isValidated()  { return this.osloValidator.isValidated; }
  get isRunning()    { return this.osloValidator.isRunning; }

  get scopeLabel() {
    const name = this.osloValidator.scopedPackageName;
    if (!this.osloValidator.isValidated) {
      return this.args.packageId != null ? 'Will validate selected package only' : 'Will validate entire model';
    }
    return name ? `Validated: ${name}` : 'Validated: entire model';
  }

  isSeverityActive = (sev) => this.filterSeverity.has(sev);
  severityIcon     = (s) => ({ error: '⛔', warning: '⚠️', info: 'ℹ️' })[s] ?? '';
  severityLabel    = (s) => ({ error: 'Error', warning: 'Warning', info: 'Info' })[s] ?? s;

  // ── actions ───────────────────────────────────────────────────────────────

  @action validate() { this.osloValidator.validate(this.args.packageId ?? null); }

  @action onFilterText(e) { this.filterText = e.target.value; }

  @action toggleSeverity(sev) {
    const next = new Set(this.filterSeverity);
    if (next.has(sev)) { if (next.size > 1) next.delete(sev); }
    else next.add(sev);
    this.filterSeverity = next;
  }

  <template>
    <div class="vv-wrap">

      {{! ── toolbar ──────────────────────────────────────────────────────── }}
      <div class="vv-toolbar">
        <button class="btn btn--primary {{if this.isRunning 'btn--running'}}" type="button"
          disabled={{this.isRunning}} {{on "click" this.validate}}>
          {{if this.isRunning "Running…" (if this.isValidated "Re-validate" "Run Validation")}}
        </button>

        <span class="vv-scope">{{this.scopeLabel}}</span>

        {{#if this.isValidated}}
          <button type="button"
            class="vv-badge vv-badge--error {{if (this.isSeverityActive 'error') '' 'vv-badge--dimmed'}}"
            title="Toggle errors"
            {{on "click" (fn this.toggleSeverity "error")}}>
            ⛔ {{this.errorCount}} error{{if (eq this.errorCount 1) "" "s"}}
          </button>
          <button type="button"
            class="vv-badge vv-badge--warning {{if (this.isSeverityActive 'warning') '' 'vv-badge--dimmed'}}"
            title="Toggle warnings"
            {{on "click" (fn this.toggleSeverity "warning")}}>
            ⚠️ {{this.warningCount}} warning{{if (eq this.warningCount 1) "" "s"}}
          </button>
          <button type="button"
            class="vv-badge vv-badge--info {{if (this.isSeverityActive 'info') '' 'vv-badge--dimmed'}}"
            title="Toggle info"
            {{on "click" (fn this.toggleSeverity "info")}}>
            ℹ️ {{this.infoCount}} info
          </button>

          <input class="input vv-search" type="search" placeholder="Search…"
            value={{this.filterText}} oninput={{this.onFilterText}} />

          <span class="vv-count">{{this.filteredResults.length}} shown</span>
        {{/if}}
      </div>

      {{! ── empty / not-yet-run states ───────────────────────────────────── }}
      {{#if (not this.isValidated)}}
        <p class="vv-placeholder">
          Click <strong>Run Validation</strong> to check the loaded model against OSLO conventions.
        </p>
      {{else if (eq this.filteredResults.length 0)}}
        <p class="vv-placeholder">
          {{#if (eq this.results.length 0)}}
            ✅ No issues found.
          {{else}}
            No results match the current filters.
          {{/if}}
        </p>
      {{else}}

        {{! ── results table ────────────────────────────────────────────── }}
        <div class="vv-scroll">
          <table class="vv-table">
            <thead>
              <tr>
                <th class="vv-col-sev"></th>
                <th class="vv-col-type">Type</th>
                <th class="vv-col-entity">Element / Name</th>
                <th class="vv-col-tag">Tag</th>
                <th class="vv-col-msg">Message</th>
              </tr>
            </thead>
            <tbody>
              {{#each this.filteredResults as |r|}}
                <tr class="vv-row vv-row--{{r.severity}}">
                  <td class="vv-col-sev" title={{this.severityLabel r.severity}}>
                    {{this.severityIcon r.severity}}
                  </td>
                  <td class="vv-col-type">
                    {{#if r.entityType}}
                      <span class="vv-type-badge vv-type-badge--{{r.entityType}}">{{r.entityType}}</span>
                    {{/if}}
                  </td>
                  <td class="vv-col-entity mono">{{r.entity}}</td>
                  <td class="vv-col-tag mono">{{r.tagName}}</td>
                  <td class="vv-col-msg">{{r.message}}</td>
                </tr>
              {{/each}}
            </tbody>
          </table>
        </div>

      {{/if}}
    </div>
  </template>
}
