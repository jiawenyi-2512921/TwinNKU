/** A missing response is not a failed write. Recovery only reads the operation. */
export class UnconfirmedOperation extends Error {
  operationId: string;
  constructor(id: string) {
    super("操作结果尚未确认。请查询本次结果，不要重复提交。");
    this.name = "UnconfirmedOperation";
    this.operationId = id;
  }
}
export async function confirmedOperation<T>(
  operationId: string,
  write: () => Promise<T>,
  recover: (id: string) => Promise<T | null>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      status !== 408
    )
      throw error;
    try {
      const result = await recover(operationId);
      if (result) return result;
    } catch {
      /* A failed read cannot establish a failed write. */
    }
    throw new UnconfirmedOperation(operationId);
  }
}
