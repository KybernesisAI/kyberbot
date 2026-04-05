/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/renderer/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['Space Mono', 'SF Mono', 'Monaco', 'Menlo', 'monospace'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        emerald: {
          DEFAULT: '#10b981',
          dim: '#059669',
        },
        cyan: {
          DEFAULT: '#22d3ee',
          dim: '#0891b2',
        },
      },
    },
  },
  plugins: [],
};
