import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        // Self-contained AudioWorklet bundle (includes LiteRT WASM + models inlined).
        {
          src: 'node_modules/@workadventure/noise-suppression/dist/assets/audio-worklet-processor.js',
          dest: 'noise-suppression',
        },
        // Quantised DTLN tflite models for the main-thread frame API (used in export).
        {
          src: 'node_modules/@workadventure/noise-suppression/dist/assets/model_quant_1.tflite',
          dest: 'noise-suppression',
        },
        {
          src: 'node_modules/@workadventure/noise-suppression/dist/assets/model_quant_2.tflite',
          dest: 'noise-suppression',
        },
        // LiteRT WASM runtime files for the frame API.
        {
          src: 'node_modules/@workadventure/noise-suppression/dist/vendor/litert/*',
          dest: 'noise-suppression/vendor/litert',
        },
      ],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'screenshots/*.png'],
      manifest: false,
      workbox: {
        // Exclude the large DTLN worklet bundle from precache — served and cached separately.
        globIgnores: ['noise-suppression/**'],
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-cache',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /\/noise-suppression\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'dtln-cache',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // These packages use WASM or large binary assets that must not be inlined
    // by Vite's pre-bundler; they are loaded as external URLs at runtime.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@workadventure/noise-suppression'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@ffmpeg')) return 'ffmpeg'
          if (id.includes('wavesurfer')) return 'wavesurfer'
        },
      },
    },
  },
})
