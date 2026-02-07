/**
 * Privy Configuration for MentionFi
 *
 * Get your App ID from: https://dashboard.privy.io
 */

// MegaETH chain definitions for Privy
export const megaethTestnet = {
  id: 6343,
  name: 'MegaETH Testnet',
  network: 'megaeth-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['https://carrot.megaeth.com/rpc'] },
    public: { http: ['https://carrot.megaeth.com/rpc'] },
  },
  blockExplorers: {
    default: { name: 'MegaETH Explorer', url: 'https://megaeth-testnet-v2.blockscout.com' },
  },
};

export const megaethMainnet = {
  id: 4326,
  name: 'MegaETH Mainnet',
  network: 'megaeth',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['https://mainnet.megaeth.com/rpc'] },
    public: { http: ['https://mainnet.megaeth.com/rpc'] },
  },
  blockExplorers: {
    default: { name: 'MegaETH Explorer', url: 'https://mega.etherscan.io' },
  },
};

// Privy configuration
export const privyConfig = {
  // Login methods
  loginMethods: ['email', 'wallet'],

  // Appearance
  appearance: {
    theme: 'dark',
    accentColor: '#00ff88',
  },

  // Embedded wallets
  embeddedWallets: {
    createOnLogin: 'all-users',
  },

  // Supported chains
  supportedChains: [megaethTestnet],
};

export default privyConfig;
