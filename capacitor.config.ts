import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.folio.reader",
  appName: "Folio",
  webDir: "dist",
  loggingBehavior: "none",
  server: { hostname: "localhost", androidScheme: "https", cleartext: false },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    backgroundColor: "#f5f6f2",
  },
};

export default config;
