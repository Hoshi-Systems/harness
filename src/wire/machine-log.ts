/** One observable provisioning line, shared by the machine and its clients. */
export interface MachineLogEntry {
  id: number
  ts: string
  level: 'info' | 'success' | 'error'
  message: string
  count: number
}
