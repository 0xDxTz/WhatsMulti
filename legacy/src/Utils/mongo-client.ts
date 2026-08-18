import mongoose from 'mongoose';
import { Configs } from '../Stores';
import { logger } from './logger';

export const connectToMongo = async () => {
    try {
        const mongoUri = Configs.getValue('mongoUri');
        if (!mongoUri) return logger.error('Mongo URI is not defined');
        if (isMongoDBConnected()) return;

        logger.info('Connecting to MongoDB...');
        await mongoose.connect(mongoUri);
        logger.info('Connected to MongoDB');
    } catch (error) {
        logger.error(error);
    }
};

export const isMongoDBConnected = (): boolean => {
    return mongoose.connection.readyState === 1;
};

export const getAuthModel = async (sessionId: string) => {
    if (!isMongoDBConnected()) {
        await connectToMongo();
    }

    const schema = new mongoose.Schema<{ _id: string; data: string }>({
        _id: { type: String, required: true },
        data: String,
    });

    return mongoose.models[sessionId] || mongoose.model(sessionId, schema);
};

export { mongoose };
