// Languages for fenced code blocks. Each grammar is a lazy chunk, loaded the first time it's used.

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

const lang = (
  name: string,
  alias: string[],
  load: () => Promise<LanguageSupport>,
): LanguageDescription => LanguageDescription.of({ name, alias, load });

export const codeLanguages: LanguageDescription[] = [
  lang('JavaScript', ['js', 'javascript', 'mjs', 'cjs', 'node'], async () => {
    const m = await import('@codemirror/lang-javascript');
    return new LanguageSupport(m.javascriptLanguage);
  }),
  lang('JSX', ['jsx'], async () => new LanguageSupport((await import('@codemirror/lang-javascript')).jsxLanguage)),
  lang('TypeScript', ['ts', 'typescript', 'mts'], async () =>
    new LanguageSupport((await import('@codemirror/lang-javascript')).typescriptLanguage),
  ),
  lang('TSX', ['tsx'], async () => new LanguageSupport((await import('@codemirror/lang-javascript')).tsxLanguage)),
  lang('Rust', ['rust', 'rs'], async () => new LanguageSupport((await import('@codemirror/lang-rust')).rustLanguage)),
  lang('Python', ['python', 'py'], async () =>
    new LanguageSupport((await import('@codemirror/lang-python')).pythonLanguage),
  ),
  lang('Go', ['go', 'golang'], async () => new LanguageSupport((await import('@codemirror/lang-go')).goLanguage)),
  lang('C++', ['c', 'cpp', 'c++', 'cc', 'h', 'hpp'], async () =>
    new LanguageSupport((await import('@codemirror/lang-cpp')).cppLanguage),
  ),
  lang('Java', ['java', 'kotlin', 'kt'], async () =>
    new LanguageSupport((await import('@codemirror/lang-java')).javaLanguage),
  ),
  lang('JSON', ['json', 'jsonc', 'json5'], async () =>
    new LanguageSupport((await import('@codemirror/lang-json')).jsonLanguage),
  ),
  lang('CSS', ['css', 'scss'], async () => new LanguageSupport((await import('@codemirror/lang-css')).cssLanguage)),
  // lang-html is avoided on purpose: lang-markdown imports it statically, so a dynamic import here
  // would drag the HTML/CSS/JS grammars into the main chunk. The legacy XML mode is tiny.
  lang('HTML', ['html', 'htm', 'xml', 'svg', 'vue'], async () =>
    new LanguageSupport(StreamLanguage.define((await import('@codemirror/legacy-modes/mode/xml')).html)),
  ),
  lang('SQL', ['sql', 'postgres', 'postgresql', 'sqlite', 'mysql'], async () => (await import('@codemirror/lang-sql')).sql()),
  lang('YAML', ['yaml', 'yml'], async () => new LanguageSupport((await import('@codemirror/lang-yaml')).yamlLanguage)),
  lang('Shell', ['sh', 'bash', 'shell', 'zsh', 'console', 'shellsession'], async () =>
    new LanguageSupport(StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell)),
  ),
  lang('TOML', ['toml'], async () =>
    new LanguageSupport(StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml)),
  ),
  lang('Diff', ['diff', 'patch'], async () =>
    new LanguageSupport(StreamLanguage.define((await import('@codemirror/legacy-modes/mode/diff')).diff)),
  ),
  lang('Dockerfile', ['dockerfile', 'docker'], async () =>
    new LanguageSupport(StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile)),
  ),
];
