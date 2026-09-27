/** @type {import('tailwindcss').Config} */

// Every used palette maps to a CSS custom property (--twc-<name>-<shade>)
// defined in src/index.css. Theme switching is pure CSS: [data-theme="light"]
// redefines the variables; utilities like bg-slate-900 or text-sky-400 keep
// working (including /alpha modifiers) with remapped values.
const ramp = (name) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((s) => [
      s,
      `rgb(var(--twc-${name}-${s}) / <alpha-value>)`,
    ]),
  );

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        slate: ramp("slate"),
        sky: ramp("sky"),
        emerald: ramp("emerald"),
        rose: ramp("rose"),
        amber: ramp("amber"),
        violet: ramp("violet"),
        cyan: ramp("cyan"),
        teal: ramp("teal"),
        fuchsia: ramp("fuchsia"),
      },
    },
  },
  plugins: [],
};
