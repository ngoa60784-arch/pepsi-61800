import type { CustomProvider } from "./types"

const deepseek: CustomProvider = {
    name: "deepseek",
    config: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "DEEPSEEK_API_KEY",
        api: "openai-completions",
        models: [
            {
                id: "deepseek-v4-flash",
                name: "DeepSeek V4 Flash",
                reasoning: true,
                input: ["text"],
                cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 131_072,
            },
            {
                id: "deepseek-v4-pro",
                name: "DeepSeek V4 Pro",
                reasoning: true,
                input: ["text"],
                cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 131_072,
            },
            {
                id: "deepseek-chat",
                name: "DeepSeek Chat (legacy → V4 Flash)",
                reasoning: false,
                input: ["text"],
                cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 131_072,
            },
            {
                id: "deepseek-reasoner",
                name: "DeepSeek Reasoner (legacy → V4 Flash thinking)",
                reasoning: true,
                input: ["text"],
                cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 131_072,
            },
        ],
    },
}

export default deepseek
