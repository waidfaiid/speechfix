/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0f0e0d',       
        card: '#252320',     
        'card-elevated': '#31302d',
        'card-border': '#4d4a47',   
        accent: '#f59e0b',   
        'accent-hover': '#d97706',
        'accent-glow': 'rgba(245, 158, 11, 0.2)',
        'text-primary': '#f5f5f4',     
        'text-secondary': '#c5c1bc',
        'slider-track': '#1b1a18',
        'slider-thumb': '#f5f5f4',
        success: '#22c55e',
        warning: '#f59e0b',
        error: '#ef4444',
      },
      borderRadius: {
        card: '12px',
        pill: '999px',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        tech: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-left': {
          '0%': { opacity: '0', transform: 'translateX(-24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'wave-bar': {
          '0%, 100%': { transform: 'scaleY(0.45)' },
          '50%': { transform: 'scaleY(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'slide-in-right': 'slide-in-right 0.42s cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-left': 'slide-in-left 0.42s cubic-bezier(0.22, 1, 0.36, 1)',
        'wave-bar': 'wave-bar 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
