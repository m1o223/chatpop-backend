export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Authentication required or credentials invalid')
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Resource not found')
