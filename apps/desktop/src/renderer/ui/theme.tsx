import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";

/* eslint-disable react-refresh/only-export-components -- provider and typed hook form one boundary. */

import type { AppTheme } from "@forgedeck/schemas";

interface ThemeContextValue {
  readonly theme: AppTheme;
  readonly setTheme: (theme: AppTheme) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  theme,
  setTheme
}: ThemeContextValue & { readonly children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("ThemeProvider is required");
  }
  return value;
}
