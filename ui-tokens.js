(function initCYDTokens(global) {
  const UI_TOKENS = {
    palette: {
      bg: "#000000",
      panel: "#000000",
      panelAlt: "#000000",
      line: "#7f7f7f",
      text: "#ffffff",
      dim: "#7f7f7f",
      accentGreen: "#2dff64",
      accentRed: "#ff4c5c",
      accentCyan: "#45e3ff",
      track: ["#ff4c5c", "#ffe15a", "#45e3ff", "#ff6ce6", "#2dff64"],
    },
    spacing: {
      unit: 4,
      xs: 4,
      sm: 8,
      md: 12,
      lg: 16,
    },
    typography: {
      sm: 12,
      md: 16,
      lineHeight: 1.333,
      letterSpacingWide: "0.08em",
      letterSpacingTight: "0.06em",
    },
    state: {
      active: {
        border: "#45e3ff",
        background: "rgba(69, 227, 255, 0.16)",
        text: "#ffffff",
      },
      muted: {
        border: "#ff4c5c",
        background: "rgba(255, 76, 92, 0.14)",
        text: "#ff4c5c",
      },
      warning: {
        border: "#ffe15a",
        background: "rgba(255, 225, 90, 0.18)",
        text: "#ffe15a",
      },
    },
  };

  function cssVarMap(tokens) {
    return {
      "--bg": tokens.palette.bg,
      "--panel": tokens.palette.panel,
      "--panel-2": tokens.palette.panelAlt,
      "--line": tokens.palette.line,
      "--text": tokens.palette.text,
      "--dim": tokens.palette.dim,
      "--green": tokens.palette.accentGreen,
      "--red": tokens.palette.accentRed,
      "--cyan": tokens.palette.accentCyan,
      "--unit": `${tokens.spacing.unit}px`,
      "--font-sm": `${tokens.typography.sm}px`,
      "--font-md": `${tokens.typography.md}px`,
      "--line-height": String(tokens.typography.lineHeight),
      "--letter-wide": tokens.typography.letterSpacingWide,
      "--letter-tight": tokens.typography.letterSpacingTight,
      "--state-active-border": tokens.state.active.border,
      "--state-active-bg": tokens.state.active.background,
      "--state-active-text": tokens.state.active.text,
      "--state-muted-border": tokens.state.muted.border,
      "--state-muted-bg": tokens.state.muted.background,
      "--state-muted-text": tokens.state.muted.text,
      "--state-warning-border": tokens.state.warning.border,
      "--state-warning-bg": tokens.state.warning.background,
      "--state-warning-text": tokens.state.warning.text,
    };
  }

  function applyTokensToCSS(tokens = UI_TOKENS) {
    if (!global.document || !global.document.documentElement) return;
    const vars = cssVarMap(tokens);
    Object.entries(vars).forEach(([name, value]) => {
      global.document.documentElement.style.setProperty(name, value);
    });
  }

  global.UI_TOKENS = UI_TOKENS;
  global.applyTokensToCSS = applyTokensToCSS;
  applyTokensToCSS(UI_TOKENS);
})(window);
