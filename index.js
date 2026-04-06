require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { ethers } = require("ethers");
const CryptoJS = require("crypto-js");
const fs = require("fs");

// ===== CONFIG =====
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const DB_FILE = "./walletStore.json";

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const NETWORKS = {
  ETH: {
    label: "Ethereum",
    symbol: "ETH",
    rpc: process.env.RPC_URL_ETH || process.env.RPC_URL || "https://mainnet.infura.io/v3/",
  },
  BSC: {
    label: "BSC",
    symbol: "BNB",
    rpc: process.env.RPC_URL_BSC || "https://bsc-dataseed.binance.org/",
  },
  OP: {
    label: "Optimism",
    symbol: "OP",
    rpc: process.env.RPC_URL_OPTIMISM || "https://mainnet.optimism.io/",
  },
  ARB: {
    label: "Arbitrum",
    symbol: "ARB",
    rpc: process.env.RPC_URL_ARBITRUM || "https://arb1.arbitrum.io/rpc",
  },
};

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  const raw = fs.readFileSync(DB_FILE, "utf8");
  if (!raw) return {};
  const data = JSON.parse(raw);
  return migrateOldDB(data);
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, process.env.SECRET_KEY).toString();
}

function decrypt(cipher) {
  const bytes = CryptoJS.AES.decrypt(cipher, process.env.SECRET_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

function normalizeNetwork(input) {
  if (!input) return "ETH";
  const value = input.trim().toUpperCase();
  if (["ETH", "ETHEREUM"].includes(value)) return "ETH";
  if (["BSC", "BNB"].includes(value)) return "BSC";
  if (["OP", "OPTIMISM"].includes(value)) return "OP";
  if (["ARB", "ARBITRUM"].includes(value)) return "ARB";
  return null;
}

function getNetworkConfig(network) {
  return NETWORKS[network] || null;
}

function getProvider(network) {
  const config = getNetworkConfig(network);
  if (!config) throw new Error("Unsupported network");
  return new ethers.JsonRpcProvider(config.rpc);
}

async function getTokenPrice(contractAddress, network) {
  try {
    const platform = network === "BSC" ? "binance-smart-chain" : "ethereum"; // Add more if needed
    const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${contractAddress}&vs_currencies=usd`;
    const response = await fetch(url);
    const data = await response.json();
    return data[contractAddress.toLowerCase()]?.usd || null;
  } catch (error) {
    console.error("Error fetching token price:", error);
    return null;
  }
}

async function getNativeUsdPrice(network) {
  try {
    const id = network === "BSC" ? "binancecoin" : "ethereum";
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const response = await fetch(url);
    const data = await response.json();
    return data[id]?.usd || null;
  } catch (error) {
    console.error("Error fetching native USD price:", error);
    return null;
  }
}

async function getTokenDecimals(contractAddress, provider) {
  try {
    const contract = new ethers.Contract(contractAddress, ["function decimals() view returns (uint8)"], provider);
    const decimals = await contract.decimals();
    return Number(decimals);
  } catch (error) {
    console.error("Error fetching token decimals:", error);
    return 18; // Default
  }
}

async function getTokenBalance(contractAddress, owner, provider) {
  try {
    const contract = new ethers.Contract(contractAddress, ERC20_ABI, provider);
    return await contract.balanceOf(owner);
  } catch (error) {
    console.error("Error fetching token balance:", error);
    return 0n;
  }
}

function migrateOldDB(data) {
  let migrated = false;
  Object.entries(data).forEach(([chatId, entry]) => {
    if (entry && !entry.wallets && entry.address && entry.key) {
      data[chatId] = {
        wallets: [
          {
            name: "default",
            address: entry.address,
            key: entry.key,
            network: "ETH",
          },
        ],
      };
      migrated = true;
    }
  });

  if (migrated) {
    saveDB(data);
  }

  return data;
}

function getWalletListText(wallets) {
  return wallets
    .map(
      (wallet, index) =>
        `${index + 1}. ${wallet.name} (${wallet.network})\n   ${wallet.address}`
    )
    .join("\n\n");
}

function findWallet(wallets, input) {
  const normalized = input.trim().toLowerCase();
  const index = parseInt(normalized, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= wallets.length) {
    return wallets[index - 1];
  }
  return wallets.find(
    (wallet) =>
      wallet.name.toLowerCase() === normalized ||
      wallet.network.toLowerCase() === normalized
  );
}

function getNativeSymbol(network) {
  return NETWORKS[network]?.symbol || "ETH";
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`Wallet Bot Ready

/import - import wallet(s)
/wallets - list your wallets
/balance - check balances
/receive - show addresses
/send - send native funds
/sendtoken - send tokens
/delete - remove a wallet
/help - show commands`
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`Commands:
/import - import wallet(s) (multiple per message)
/wallets - list saved wallets
/balance - view balances for all wallets
/receive - show wallet addresses
/send - send native funds
/sendtoken - send ERC-20 tokens (one-line input)
/delete - remove a saved wallet
Supported networks: ETH, BSC, OP, ARB`
  );
});

bot.onText(/\/import/, (msg) => {
  bot.sendMessage(msg.chat.id, "Which network? (ETH, BSC, OP, ARB)\nDefault: ETH");

  bot.once("message", (msg2) => {
    const networkKey = normalizeNetwork(msg2.text || "ETH");
    if (!networkKey) {
      return bot.sendMessage(msg.chat.id, "Unsupported network.");
    }

    bot.sendMessage(msg.chat.id, "Send PRIVATE KEY(s) or SEED PHRASE(s), one per line:");

    bot.once("message", (msg3) => {
      const inputs = msg3.text.trim().split("\n").map(line => line.trim()).filter(line => line);
      if (inputs.length === 0) {
        return bot.sendMessage(msg.chat.id, "No keys provided.");
      }

      const db = loadDB();
      const entry = db[msg.chat.id] || { wallets: [] };
      let importedCount = 0;

      inputs.forEach((input, index) => {
        try {
          let wallet;
          if (input.split(" ").length > 1) {
            wallet = ethers.Wallet.fromPhrase(input);
          } else {
            wallet = new ethers.Wallet(input);
          }

          const name = `${networkKey.toLowerCase()}-wallet-${entry.wallets.length + 1}`;
          entry.wallets.push({
            name,
            address: wallet.address,
            key: encrypt(input),
            network: networkKey,
          });
          importedCount++;
        } catch (error) {
          // Skip invalid keys
        }
      });

      if (importedCount > 0) {
        db[msg.chat.id] = entry;
        saveDB(db);
        bot.sendMessage(msg.chat.id, `Imported ${importedCount} wallet(s) on ${networkKey}`);
      } else {
        bot.sendMessage(msg.chat.id, "No valid keys imported.");
      }
    });
  });
});

bot.onText(/\/wallets/, (msg) => {
  const db = loadDB();
  const user = db[msg.chat.id];

  if (!user || !user.wallets || user.wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, "No wallets found. Use /import to add one.");
  }

  bot.sendMessage(msg.chat.id, `Saved wallets:\n\n${getWalletListText(user.wallets)}`);
});

bot.onText(/\/delete/, (msg) => {
  const db = loadDB();
  const user = db[msg.chat.id];

  if (!user || !user.wallets || user.wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, "No wallets found. Use /import to add one.");
  }

  bot.sendMessage(
    msg.chat.id,
    `Select wallet to delete by number or name:\n\n${getWalletListText(user.wallets)}`
  );

  bot.once("message", (msg2) => {
    const selected = findWallet(user.wallets, msg2.text);
    if (!selected) {
      return bot.sendMessage(msg.chat.id, "Wallet not found.");
    }

    user.wallets = user.wallets.filter(
      (wallet) => wallet.address !== selected.address || wallet.network !== selected.network || wallet.name !== selected.name
    );

    if (user.wallets.length === 0) {
      delete db[msg.chat.id];
    } else {
      db[msg.chat.id] = user;
    }

    saveDB(db);
    bot.sendMessage(msg.chat.id, `Deleted wallet: ${selected.name} (${selected.network})`);
  });
});

bot.onText(/\/balance/, async (msg) => {
  const db = loadDB();
  const user = db[msg.chat.id];

  if (!user || !user.wallets || user.wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, "No wallets found. Use /import to add one.");
  }

  try {
    const balances = await Promise.all(
      user.wallets.map(async (wallet) => {
        try {
          const provider = getProvider(wallet.network);
          const value = await provider.getBalance(wallet.address);
          return {
            wallet,
            balance: ethers.formatEther(value),
          };
        } catch (innerError) {
          return {
            wallet,
            balance: null,
            error: true,
          };
        }
      })
    );

    const lines = balances.map(({ wallet, balance, error }) => {
      const balanceText = error
        ? "Unavailable"
        : `${balance} ${getNativeSymbol(wallet.network)}`;
      return `${wallet.name} (${wallet.network})\n${wallet.address}\nBalance: ${balanceText}`;
    });

    bot.sendMessage(msg.chat.id, lines.join("\n\n"));
  } catch (error) {
    bot.sendMessage(msg.chat.id, "Error fetching balances.");
  }
});

bot.onText(/\/receive/, (msg) => {
  const db = loadDB();
  const user = db[msg.chat.id];

  if (!user || !user.wallets || user.wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, "No wallets found. Use /import to add one.");
  }

  bot.sendMessage(msg.chat.id, `Wallet addresses:\n\n${getWalletListText(user.wallets)}`);
});

bot.onText(/^\/send$/, (msg) => {
  const db = loadDB();
  const user = db[msg.chat.id];

  if (!user || !user.wallets || user.wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, "No wallets found. Use /import to add one.");
  }

  const walletPrompt = user.wallets.length === 1 ? user.wallets[0] : null;

  const selectWallet = (selectedWallet) => {
    bot.sendMessage(msg.chat.id, "Recipient address:");

    bot.once("message", (msg2) => {
      const to = msg2.text.trim();
      bot.sendMessage(
        msg.chat.id,
        `Amount in ${getNativeSymbol(selectedWallet.network)}:`
      );

      bot.once("message", async (msg3) => {
        try {
          const amount = msg3.text.trim();
          if (!ethers.isAddress(to)) {
            return bot.sendMessage(msg.chat.id, "Invalid recipient address.");
          }

          const parsedAmount = parseFloat(amount);
          if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return bot.sendMessage(msg.chat.id, "Invalid amount.");
          }

          const value = ethers.parseEther(amount);
          const pk = decrypt(selectedWallet.key);
          const provider = getProvider(selectedWallet.network);
          const wallet = new ethers.Wallet(pk, provider);

          const txRequest = {
            to,
            value,
          };

          try {
            txRequest.gasLimit = await wallet.estimateGas(txRequest);
          } catch (estimateError) {
            // fallback if estimation fails
          }

          const tx = await wallet.sendTransaction(txRequest);

          bot.sendMessage(msg.chat.id, `TX Sent:\n${tx.hash}`);
        } catch (error) {
          console.error("Send transaction error:", error);
          const message =
            error && error.message
              ? `Transaction failed: ${error.message}`
              : "Transaction failed.";
          bot.sendMessage(msg.chat.id, message);
        }
      });
    });
  };

  if (walletPrompt) {
    selectWallet(walletPrompt);
  } else {
    bot.sendMessage(
      msg.chat.id,
      `Select wallet by number or name:\n\n${getWalletListText(user.wallets)}`
    );

    bot.once("message", (msg2) => {
      const selected = findWallet(user.wallets, msg2.text);
      if (!selected) {
        return bot.sendMessage(msg.chat.id, "Wallet not found.");
      }
      selectWallet(selected);
    });
  }
});
bot.onText(/^\/sendtoken$/, (msg) => {
  const db = loadDB();
  const user = db[msg.chat.id];

  if (!user || !user.wallets || user.wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, "No wallets found. Use /import to add one.");
  }

  const walletPrompt = user.wallets.length === 1 ? user.wallets[0] : null;

  const selectWallet = (selectedWallet) => {
    bot.sendMessage(
      msg.chat.id,
      "Send token details in one line:\nCA, recipient address, amount (USD, BNB, 25%, 50%, 75%, or max)\nExample: 0x...,0x...,10 usd"
    );

    bot.once("message", async (msg2) => {
      try {
        const parts = msg2.text
          .split(/\s*,\s*/)
          .map((part) => part.trim())
          .filter((part) => part);

        if (parts.length !== 3) {
          return bot.sendMessage(
            msg.chat.id,
            "Please send exactly 3 values: CA, recipient, amount (USD, BNB, 25%, 50%, 75%, or max)."
          );
        }

        const [contractAddress, to, rawAmount] = parts;
        if (!ethers.isAddress(contractAddress)) {
          return bot.sendMessage(msg.chat.id, "Invalid contract address.");
        }
        if (!ethers.isAddress(to)) {
          return bot.sendMessage(msg.chat.id, "Invalid recipient address.");
        }

        const raw = rawAmount.trim().toLowerCase();
        const provider = getProvider(selectedWallet.network);
        let decimals = await getTokenDecimals(contractAddress, provider);
        decimals = Number(decimals);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
          decimals = 18;
        }

        const tokenBalance = await getTokenBalance(contractAddress, selectedWallet.address, provider);
        if (tokenBalance === 0n) {
          return bot.sendMessage(
            msg.chat.id,
            "Insufficient token balance for this transfer. Please fund the wallet with the token first."
          );
        }

        let value;
        let usdAmount;
        if (raw === "max") {
          value = tokenBalance;
          const tokenBalanceFormatted = parseFloat(ethers.formatUnits(tokenBalance, decimals));
          const tokenPrice = await getTokenPrice(contractAddress, selectedWallet.network);
          usdAmount = tokenPrice ? tokenBalanceFormatted * tokenPrice : null;
        } else if (raw.endsWith("%")) {
          const percent = parseFloat(raw.slice(0, -1));
          if (isNaN(percent) || percent <= 0 || percent > 100) {
            return bot.sendMessage(msg.chat.id, "Invalid percentage amount.");
          }
          value = (tokenBalance * BigInt(Math.round(percent * 100))) / 100n / 100n;
          if (value === 0n) {
            return bot.sendMessage(msg.chat.id, "Percentage amount is too small for this token balance.");
          }
          const tokenPrice = await getTokenPrice(contractAddress, selectedWallet.network);
          usdAmount = tokenPrice ? parseFloat(ethers.formatUnits(value, decimals)) * tokenPrice : null;
        } else {
          const amountParts = raw.split(/\s+/);
          let amount = parseFloat(amountParts[0]);
          if (isNaN(amount) || amount <= 0) {
            return bot.sendMessage(msg.chat.id, "Invalid amount.");
          }

          let amountType = "usd";
          if (amountParts.length > 1) {
            amountType = amountParts[1];
          } else if (raw.endsWith("bnb")) {
            amountType = "bnb";
            amount = parseFloat(raw.replace(/bnb$/, ""));
          }

          if (!["usd", "bnb"].includes(amountType)) {
            return bot.sendMessage(msg.chat.id, "Amount must include USD or BNB.");
          }

          const tokenPrice = await getTokenPrice(contractAddress, selectedWallet.network);
          if (!tokenPrice) {
            return bot.sendMessage(msg.chat.id, "Unable to fetch token price. Please try again later.");
          }

          usdAmount = amount;
          if (amountType === "bnb") {
            const nativePrice = await getNativeUsdPrice(selectedWallet.network);
            if (!nativePrice) {
              return bot.sendMessage(msg.chat.id, "Unable to fetch BNB price. Please try again later.");
            }
            usdAmount = amount * nativePrice;
          }

          const tokenAmount = usdAmount / tokenPrice;
          const tokenAmountString = tokenAmount.toFixed(decimals);
          value = ethers.parseUnits(tokenAmountString, decimals);
        }

        if (tokenBalance < value) {
          return bot.sendMessage(
            msg.chat.id,
            "Insufficient token balance for this transfer. Please fund the wallet with the token first."
          );
        }

        const pk = decrypt(selectedWallet.key);
        const wallet = new ethers.Wallet(pk, provider);
        const contract = new ethers.Contract(contractAddress, ERC20_ABI, wallet);

        const tx = await contract.transfer(to, value);
        bot.sendMessage(
          msg.chat.id,
          `Token TX Sent:\n${tx.hash}\nSent ~${tokenAmount.toFixed(4)} tokens ($${usdAmount.toFixed(2)})`
        );
      } catch (error) {
        console.error("Send token error:", error);
        const message =
          error && error.message
            ? `Transaction failed: ${error.message}`
            : "Transaction failed.";
        bot.sendMessage(msg.chat.id, message);
      }
    });
  };

  if (walletPrompt) {
    selectWallet(walletPrompt);
  } else {
    bot.sendMessage(
      msg.chat.id,
      `Select wallet by number or name:\n\n${getWalletListText(user.wallets)}`
    );

    bot.once("message", (msg2) => {
      const selected = findWallet(user.wallets, msg2.text);
      if (!selected) {
        return bot.sendMessage(msg.chat.id, "Wallet not found.");
      }
      selectWallet(selected);
    });
  }
});
