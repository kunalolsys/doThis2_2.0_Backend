import AppError from "../utils/AppError.js"

export const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);

    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map(el => el.message);
        err = new AppError(messages.join(', '), 400);
    }
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        const value = err.keyValue[field];
        if (value === null || value === undefined) {
            err = new AppError(`Invalid ${field} value: cannot have duplicate null/empty values`, 400);
        } else {
            err = new AppError(`${field}: "${value}" already exists`, 400);
        }
    }
    if (err.name === 'CastError') {
        err = new AppError('Invalid ID format', 400);
    }
    if (err.message.startsWith('File already exists:')) {
        err = new AppError(err.message, 409);
    }
    res.status(err.statusCode || 500).json({
        status: 'error',
        message: err.message || 'Internal Server Error',
    });
};
