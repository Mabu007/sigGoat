import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
    ],

    /**
     * EXPOSE `FIREBASE_*` AS WELL AS `VITE_FIREBASE_*`.
     *
     * Vite only exposes variables carrying `VITE_` to client code, and this
     * project reads its Firebase web config as `VITE_FIREBASE_*`. The Vercel
     * project stores the same values as `FIREBASE_*`, so a build there produced
     * a bundle with an EMPTY Firebase config: `isFirebaseConfigured` was false,
     * the app ran in offline mode, and Google sign-in could never work. The
     * failure was silent — the page loaded normally and only the login did not.
     *
     * Both prefixes are now read, with `VITE_FIREBASE_*` taking precedence, so
     * either naming convention produces a working build. Nothing secret is
     * exposed: these are the public web keys Firebase ships to every browser.
     */
    envPrefix: ['VITE_', 'FIREBASE_'],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
