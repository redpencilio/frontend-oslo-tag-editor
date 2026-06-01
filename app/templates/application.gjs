import { pageTitle } from 'ember-page-title';
import { service } from '@ember/service';
import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import { eq } from 'ember-truth-helpers';
import FileLoader from 'oslo-tag-editor/components/file-loader';
import TagEditor from 'oslo-tag-editor/components/tag-editor';
import PackageTree from 'oslo-tag-editor/components/package-tree';
import ElementTagView   from 'oslo-tag-editor/components/element-tag-view';
import AttributeTagView from 'oslo-tag-editor/components/attribute-tag-view';
import ConnectorTagView from 'oslo-tag-editor/components/connector-tag-view';
import ValidationView   from 'oslo-tag-editor/components/validation-view';

const VIEWS = [
  { id: 'all-tags',    label: 'All Tags',    hint: 'All tagged values from t_objectproperties, t_attributetag, t_connectortag' },
  { id: 'elements',    label: 'Elements',    hint: 'OSLO tag grid for Class / DataType / Enumeration' },
  { id: 'attributes',  label: 'Attributes',  hint: 'OSLO tag grid for attributes of elements in the selected package' },
  { id: 'connectors',  label: 'Connectors',  hint: 'OSLO tag grid for Association / Aggregation connectors' },
  { id: 'validation',  label: 'Validation',  hint: 'Validate the model against OSLO conventions' },
];

class Application extends Component {
  @service eaDatabase;
  @service osloValidator;

  @tracked selectedPackageId = null;
  @tracked activeView = 'all-tags';

  @action async onLoad(file)          { await this.eaDatabase.loadFile(file); }
  @action onPackageSelect(packageId)  { this.selectedPackageId = packageId; }
  @action setView(id)                 { this.activeView = id; }
  @action exportSQL()                 { this.eaDatabase.save(); }
  @action revertAll()                 { this.eaDatabase.revertAll(); }

  @action
  onReset() {
    this.eaDatabase.isLoaded  = false;
    this.eaDatabase.fileName  = null;
    this.eaDatabase.error     = null;
    this.selectedPackageId    = null;
    this.activeView           = 'all-tags';
    this.osloValidator.reset();
  }

  get validationErrorCount() { return this.osloValidator.errorCount; }
  get validationIsRun()      { return this.osloValidator.isValidated; }

  get editCount()  { return this.eaDatabase.editCount; }
  get hasEdits()   { return this.editCount > 0; }

  <template>
    {{pageTitle "OSLO Tag Editor"}}

    <div class="app-shell">
      <header class="app-header">
        <span class="app-header__logo">OSLO</span>
        <span class="app-header__title">Tag Editor</span>
        <span class="app-header__sub">Sparx Enterprise Architect · EAP / MDB</span>
      </header>

      <main class="app-main">
        {{#if this.eaDatabase.error}}
          <div class="error-banner">
            <strong>Failed to read file:</strong> {{this.eaDatabase.error}}
          </div>
        {{/if}}

        {{#if this.eaDatabase.isLoaded}}
          <div class="workspace">
            <PackageTree
              @selectedId={{this.selectedPackageId}}
              @onSelect={{this.onPackageSelect}}
            />

            <div class="workspace__content">

              {{! ── view tab bar ────────────────────────────────────────── }}
              <nav class="view-tabs" aria-label="View">
                {{#each VIEWS as |view|}}
                  <button
                    type="button"
                    class="view-tab {{if (eq this.activeView view.id) 'view-tab--active'}}"
                    title={{view.hint}}
                    {{on "click" (fn this.setView view.id)}}
                  >
                    {{view.label}}
                    {{#if (eq view.id "validation")}}
                      {{#if this.validationIsRun}}
                        {{#if this.validationErrorCount}}
                          <span class="tab-err-badge">{{this.validationErrorCount}}</span>
                        {{else}}
                          <span class="tab-ok-badge">✓</span>
                        {{/if}}
                      {{/if}}
                    {{/if}}
                  </button>
                {{/each}}

                <span class="view-tabs__spacer"></span>

                {{#if this.hasEdits}}
                  <span class="view-tabs__edit-count" title="Pending edits across all views">
                    {{this.editCount}} edit{{if (eq this.editCount 1) "" "s"}}
                  </span>
                  <button class="btn btn--ghost" type="button"
                    title="Discard all pending edits"
                    {{on "click" this.revertAll}}>Revert all</button>
                  <button class="btn btn--primary" type="button"
                    title="Download SQL patch script"
                    {{on "click" this.exportSQL}}>Export SQL</button>
                {{/if}}

                <button class="btn btn--ghost view-tabs__reset" type="button"
                  {{on "click" this.onReset}}>← New file</button>
              </nav>

              {{! ── view content ───────────────────────────────────────── }}
              <div class="view-body">
                {{#if (eq this.activeView "all-tags")}}
                  <TagEditor @packageId={{this.selectedPackageId}} />
                {{/if}}

                {{#if (eq this.activeView "elements")}}
                  <ElementTagView @packageId={{this.selectedPackageId}} />
                {{/if}}

                {{#if (eq this.activeView "attributes")}}
                  <AttributeTagView @packageId={{this.selectedPackageId}} />
                {{/if}}

                {{#if (eq this.activeView "connectors")}}
                  <ConnectorTagView @packageId={{this.selectedPackageId}} />
                {{/if}}

                {{#if (eq this.activeView "validation")}}
                  <ValidationView @packageId={{this.selectedPackageId}} />
                {{/if}}
              </div>

            </div>
          </div>
        {{else}}
          <FileLoader @onLoad={{this.onLoad}} />
        {{/if}}
      </main>

      <footer class="app-footer">
        Client-side only · no data leaves your browser
      </footer>
    </div>
  </template>
}

export default Application;
