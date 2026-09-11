/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          indigo: '#6C5CE7',
          teal: '#00B894',
          navy: '#0F1C3F',
        },
      },
    },
  },
  plugins: [],
};
