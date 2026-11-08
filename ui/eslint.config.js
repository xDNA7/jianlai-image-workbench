import js from '@eslint/js'
import ts from 'typescript-eslint'
import hooks from 'eslint-plugin-react-hooks'

export default ts.config(
  { ignores: ['build/**', '.react-router/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'src/api/generated.ts'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { console: 'readonly', window: 'readonly', document: 'readonly', navigator: 'readonly', fetch: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', process: 'readonly' } },
    plugins: { 'react-hooks': hooks },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react-hooks/rules-of-hooks': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
