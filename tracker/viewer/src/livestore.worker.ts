import { makeWorker } from '@livestore/adapter-web/worker';
import { trackerSchema } from './livestore-schema';

makeWorker({ schema: trackerSchema });
