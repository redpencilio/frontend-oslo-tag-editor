import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';

export default class FileLoader extends Component {
  @tracked isDragOver = false;
  @tracked isLoading = false;

  @action
  async onFileInput(event) {
    const file = event.target.files?.[0];
    if (file) await this.#load(file);
  }

  @action
  onDragOver(event) {
    event.preventDefault();
    this.isDragOver = true;
  }

  @action
  onDragLeave() {
    this.isDragOver = false;
  }

  @action
  async onDrop(event) {
    event.preventDefault();
    this.isDragOver = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) await this.#load(file);
  }

  async #load(file) {
    if (!file.name.match(/\.(eap|mdb|accdb)$/i)) {
      alert(`Not a recognised EAP/MDB file: ${file.name}`);
      return;
    }
    this.isLoading = true;
    try {
      await this.args.onLoad(file);
    } finally {
      this.isLoading = false;
    }
  }

  <template>
    <div
      class="file-drop {{if this.isDragOver 'file-drop--over'}}"
      role="button"
      aria-label="Drop EAP file here or click to browse"
      ondragover={{this.onDragOver}}
      ondragleave={{this.onDragLeave}}
      ondrop={{this.onDrop}}
    >
      {{#if this.isLoading}}
        <p class="file-drop__status">Reading file…</p>
      {{else}}
        <p class="file-drop__icon">📂</p>
        <p class="file-drop__label">Drop an EAP file here</p>
        <p class="file-drop__hint">or</p>
        <label class="btn">
          Browse…
          <input
            type="file"
            accept=".eap,.mdb,.accdb"
            class="sr-only"
            onchange={{this.onFileInput}}
          />
        </label>
        <p class="file-drop__hint file-drop__hint--small">
          Accepts .eap / .mdb / .accdb (Sparx Enterprise Architect)
        </p>
      {{/if}}
    </div>
  </template>
}
