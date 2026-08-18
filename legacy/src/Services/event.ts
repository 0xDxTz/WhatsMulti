import { EventEmitter } from 'events';
import { EventMap, EventMapKey, MetaEventCallbackType } from '../Types';

type Listener<K extends EventMapKey> = (data: EventMap[K], meta: MetaEventCallbackType) => void;

export class WMEventEmitter extends EventEmitter {
    private processCallback?: (events: Partial<EventMap>, meta: MetaEventCallbackType) => void | Promise<void>;

    override on<K extends EventMapKey>(event: K, listener: Listener<K>): this {
        return super.on(event, listener);
    }

    override once<K extends EventMapKey>(event: K, listener: Listener<K>): this {
        return super.once(event, listener);
    }

    override off<K extends EventMapKey>(event: K, listener: Listener<K>): this {
        return super.off(event, listener);
    }

    process(callback: (events: Partial<EventMap>, meta: MetaEventCallbackType) => void | Promise<void>): void {
        this.processCallback = callback;
    }

    override emit<K extends EventMapKey>(event: K, data: EventMap[K], meta: MetaEventCallbackType): boolean {
        if (this.processCallback) {
            this.processCallback({ [event]: data }, meta);
        }
        return super.emit(event, data, meta);
    }
}
