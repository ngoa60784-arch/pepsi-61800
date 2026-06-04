import type { ProviderConfig } from "@mariozechner/pi-coding-agent"
import type { Model, Api } from "@mariozechner/pi-ai"

/** Custom provider registration entry */
export interface CustomProvider {
    name: string
    config: ProviderConfig
}

/** A single model definition in models.json — derived from the SDK Model<Api>, with id required and the rest optional */
export type ModelDefinition = Pick<Model<Api>, "id"> & Partial<Omit<Model<Api>, "id" | "provider" | "api" | "baseUrl">>

export type ModelConfigEntry = {
    id: string
    hash?: string
    provider: string
    providerId?: string
    modelId: string
    thinkingLevel?: string
} & Partial<Omit<Model<Api>, "id" | "provider" | "api" | "baseUrl">>

export interface ProviderPrefEntry {
    id: string
    hash?: string
    name: string
    api?: string
    baseUrl?: string
    apiKey?: string
}

export interface BuiltInProvider {
    provider: string
    apis: string[]
    baseUrls: string[]
    modelCount: number
}

export interface ConfiguredModel {
    provider: string
    providerId?: string
    runtimeProvider?: string
    id: string
    name?: string
    api?: string
    baseUrl?: string
    [key: string]: unknown
}
