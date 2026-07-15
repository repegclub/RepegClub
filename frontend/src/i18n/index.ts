import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";

// English is the product language (see project notes: brand names, UI copy,
// and marketing are English-first; Spanish is only for internal dev docs).
// Structured as a resource bundle from the start so adding another language
// later is just another locale file + registering it here - no component
// changes needed.
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
