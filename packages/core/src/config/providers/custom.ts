import type { CustomProvider } from "./types"

// Import custom providers from the individual files under providers/
import deepseek from "./deepseek"
import zhipuai from "./zhipuai"

/** All custom provider definitions */
export const customProviders: CustomProvider[] = [deepseek, zhipuai]
