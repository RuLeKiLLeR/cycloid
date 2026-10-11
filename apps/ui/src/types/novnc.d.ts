declare module "@novnc/novnc/lib/rfb.js" {
  type RfbEventMap = {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean?: boolean }>;
    securityfailure: CustomEvent<{ reason?: string }>;
    credentialsrequired: CustomEvent<{ types?: string[] }>;
    desktopname: CustomEvent<{ name?: string }>;
  };

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: { shared?: boolean; credentials?: Record<string, string>; repeaterID?: string; wsProtocols?: string[] },
    );

    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;

    disconnect(): void;
    addEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (event: RfbEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (event: RfbEventMap[K]) => void,
      options?: boolean | EventListenerOptions,
    ): void;
  }
}
