import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * `eslint-config-next` 16 exports flat config directly: `FlatCompat` is no
 * longer needed.
 */
const config = [
  ...coreWebVitals,
  ...typescript,
  { ignores: ['.next/**', 'next-env.d.ts'] },
];

export default config;
