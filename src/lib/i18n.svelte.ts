import de from "../locales/de.json";
import en from "../locales/en.json";

const dicts: Record<string, Record<string, string>> = { de, en };
export const languages = Object.keys(dicts);

const detect = () => languages.find((l) => navigator.language.toLowerCase().startsWith(l)) ?? "en";

export const locale = $state({ current: localStorage.getItem("lang") ?? detect() });

export function setLocale(lang: string) {
  locale.current = lang;
  localStorage.setItem("lang", lang);
}

/** Plural forms come from Intl.PluralRules, which already knows every language's
 *  rules — a key may be given as `key.one` / `key.other` and so on. */
export function t(key: string, params: Record<string, string | number> = {}) {
  const dict = dicts[locale.current] ?? dicts.en;
  let lookup = key;
  if (typeof params.count === "number") {
    const rule = new Intl.PluralRules(locale.current).select(params.count);
    lookup = dict[`${key}.${rule}`] !== undefined ? `${key}.${rule}` : `${key}.other`;
  }
  const text = dict[lookup] ?? dicts.en[lookup] ?? key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? ""));
}
