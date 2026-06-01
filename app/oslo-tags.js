// Base tag names — mirrors TagNames enum in
// packages/oslo-converter-uml-ea/lib/enums/TagNames.ts
export const TagNames = {
  ApCodelist:               'ap-codelist',
  ApDefinition:             'ap-definition',
  ApLabel:                  'ap-label',
  ApUsageNote:              'ap-usageNote',
  Definition:               'definition',
  DefiningPackage:          'package',
  ExternalUri:              'uri',
  Ignore:                   'ignore',
  IgnoreImplicitGeneration: 'ignoreImplicitGeneration',
  IsLiteral:                'literal',
  Label:                    'label',
  LocalName:                'name',
  PackageBaseUri:           'baseURI',
  PackageBaseUriAbbreviation: 'baseURIabbrev',
  PackageOntologyUri:       'ontologyURI',
  ParentUri:                'parentURI',
  Range:                    'range',
  Status:                   'status',
  UsageNote:                'usageNote',
};

// Language suffixes supported by the OSLO toolchain
export const Languages = ['nl', 'en', 'fr', 'de', 'es'];

// Tags that expand per language (e.g. 'label' → 'label-nl', 'label-en', …)
export const LanguageDependentTags = [
  'label',
  'definition',
  'usageNote',
  'ap-label',
  'ap-definition',
  'ap-usageNote',
];

// Tags that are language-independent (single value, no suffix)
export const LanguageIndependentTags = [
  'uri',
  'name',
  'package',
  'parentURI',
  'range',
  'literal',
  'ignore',
  'ignoreImplicitGeneration',
  'ap-codelist',
  'status',
  'baseURI',
  'baseURIabbrev',
  'ontologyURI',
];

// Prefixes used on association connector tags (source / target role tags stored
// on the connector element itself, not in t_taggedvalue role tags)
export const AssociationPrefixes = ['source-', 'source-rev-', 'target-', 'target-rev-'];

// Role tags for association ends — stored in t_taggedvalue (ConnectorRoleTag)
// where BaseClass is 'ASSOCIATION_SOURCE' or 'ASSOCIATION_TARGET'
export const RoleTags = {
  SourceApLabel: 'source.ap-label',
  SourceLabel:   'source.label',
  SourceUri:     'source.uri',
  TargetApLabel: 'target.ap-label',
  TargetLabel:   'target.label',
  TargetUri:     'target.uri',
};

// Valid values for the 'status' tag (full Vlaanderen concept URIs)
export const ValidStatuses = [
  'https://data.vlaanderen.be/id/concept/StandaardStatus/WerkgroepCharter',
  'https://data.vlaanderen.be/id/concept/StandaardStatus/ErkendeStandaard',
  'https://data.vlaanderen.be/id/concept/StandaardStatus/VerouderdeStandaard',
  'https://data.vlaanderen.be/id/concept/StandaardStatus/OntwerpStandaard',
  'https://data.vlaanderen.be/id/concept/StandaardStatus/VervangenStandaard',
  'https://data.vlaanderen.be/id/concept/StandaardStatus/KandidaatStandaard',
  'https://data.vlaanderen.be/id/concept/StandaardStatus/HerroepenStandaard',
  'https://data.vlaanderen.be/id/concept/StandaardStatus/NotaWerkgroep',
];

// EA element types that OSLO processes
export const ValidElementTypes = ['Class', 'DataType', 'Enumeration'];

// EA connector types that OSLO processes
export const ValidConnectorTypes = ['Association', 'Aggregation', 'Generalization'];

// Per-element-type tag expectations, used to drive validation and UI hints
export const ExpectedTags = {
  element: {
    required:    ['label-nl', 'definition-nl'],
    recommended: ['label-en', 'definition-en', 'usageNote-nl'],
    optional: [
      'uri', 'name', 'package', 'parentURI', 'status', 'ignore',
      'ap-label-nl', 'ap-definition-nl', 'ap-usageNote-nl',
    ],
  },
  enumeration: {
    required:    ['label-nl', 'definition-nl'],
    recommended: ['ap-codelist'],
    optional:    ['uri', 'name', 'package', 'status', 'ignore'],
  },
  package: {
    required:    ['baseURI'],
    recommended: ['baseURIabbrev', 'ontologyURI'],
    optional:    [],
  },
  attribute: {
    required:    ['label-nl', 'definition-nl'],
    recommended: ['label-en', 'definition-en', 'usageNote-nl'],
    optional: [
      'uri', 'name', 'package', 'parentURI', 'range', 'status',
      'ap-label-nl', 'ap-definition-nl', 'ap-usageNote-nl',
    ],
  },
  connector: {
    required:    ['label-nl', 'definition-nl'],
    recommended: ['label-en', 'definition-en', 'usageNote-nl'],
    optional: [
      'uri', 'name', 'package', 'parentURI', 'status',
      'ap-label-nl', 'ap-definition-nl', 'ap-usageNote-nl',
    ],
  },
};

// ── derived helpers ──────────────────────────────────────────────────────────

/**
 * All expanded tag names for language-dependent base tags across all supported
 * languages, e.g. ['label-nl', 'label-en', …, 'definition-nl', …]
 */
export const AllLanguageTagVariants = LanguageDependentTags.flatMap((base) =>
  Languages.map((lang) => `${base}-${lang}`),
);

/**
 * Complete set of OSLO tag names (language-independent + all language variants).
 */
export const AllOsloTagNames = new Set([
  ...LanguageIndependentTags,
  ...AllLanguageTagVariants,
  ...Object.values(RoleTags),
]);

/**
 * Returns true if a raw EA tag name is a recognised OSLO tag.
 * Handles both the base names and fully expanded names (e.g. 'label-nl').
 */
export function isOsloTag(tagName) {
  return AllOsloTagNames.has(tagName);
}

/**
 * Given a tag name, returns the base name and language suffix (or null).
 * e.g. 'label-nl' → { base: 'label', lang: 'nl' }
 *      'uri'      → { base: 'uri',   lang: null }
 */
export function parseTagName(tagName) {
  for (const lang of Languages) {
    const suffix = `-${lang}`;
    if (tagName.endsWith(suffix)) {
      const base = tagName.slice(0, -suffix.length);
      if (LanguageDependentTags.includes(base)) {
        return { base, lang };
      }
    }
  }
  return { base: tagName, lang: null };
}

/**
 * Short human-readable label for a status URI.
 * Returns the last path segment (e.g. 'ErkendeStandaard').
 */
export function statusLabel(uri) {
  return uri?.split('/').at(-1) ?? uri;
}
