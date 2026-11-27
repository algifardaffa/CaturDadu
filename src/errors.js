export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const check = (ok, message, status) => { if (!ok) throw new AppError(message, status); };
