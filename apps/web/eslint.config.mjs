import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * `eslint-config-next` 16 exporte directement du flat config :
 * plus besoin de `FlatCompat`.
 */
const config = [
  ...coreWebVitals,
  ...typescript,
  { ignores: ['.next/**', 'next-env.d.ts'] },
];

export default config;
