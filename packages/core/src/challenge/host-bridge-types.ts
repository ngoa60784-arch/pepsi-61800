export type HostBridgeAction =
    | "challenge_get_state"
    | "challenge_get_hint"
    | "challenge_submit_flag"
    | "challenge_is_completed"
    | "challenge_promote_memory"
    | "challenge_promote_idea"
    | "state_upsert"
    | "relation_upsert"
    | "relation_query"
    | "relation_path"
    | "artifact_create"
    | "campaign_memory_search"
    | "campaign_task_update"

export interface HostBridgeRequestEvent {
    type: "host_bridge_request"
    request_id: string
    action: HostBridgeAction
    params: unknown
}
