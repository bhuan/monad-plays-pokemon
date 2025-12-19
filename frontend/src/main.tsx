import { Buffer } from "buffer";
// Polyfill Buffer for browser compatibility
(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets";
import { WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig, monadTestnet } from "./config/wagmi";
import "./index.css";
import App from "./App.tsx";

const queryClient = new QueryClient();

// Get Privy App ID from environment variable
const privyAppId = import.meta.env.VITE_PRIVY_APP_ID;

if (!privyAppId) {
  console.warn("VITE_PRIVY_APP_ID not set. Get one at https://console.privy.io");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrivyProvider
      appId={privyAppId || "placeholder-app-id"}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#7C3AED",
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
        loginMethods: ["email", "wallet"],
      }}
    >
      <SmartWalletsProvider>
        <QueryClientProvider client={queryClient}>
          <WagmiProvider config={wagmiConfig}>
            <App />
          </WagmiProvider>
        </QueryClientProvider>
      </SmartWalletsProvider>
    </PrivyProvider>
  </StrictMode>
);
