import { useContext } from "react"
import { ConfirmDialogContext } from "../components/confirm-dialog-provider"

export function useConfirm() {
    const confirm = useContext(ConfirmDialogContext)
    if (!confirm) {
        throw new Error("useConfirm must be used within ConfirmDialogProvider")
    }
    return confirm
}
