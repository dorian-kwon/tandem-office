/** App AI candidates never pass through the web comparison driver. */
export const CONNECTED_AI_ENGINE_ID = 'connected-ai'
export const COMPARE_ENGINE_IDS = ['copilot', CONNECTED_AI_ENGINE_ID] as const
export type CompareEngineId = (typeof COMPARE_ENGINE_IDS)[number]
