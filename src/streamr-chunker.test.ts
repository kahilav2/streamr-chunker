import { StreamrChunker } from './streamr-chunker';

describe('StreamrChunker', () => {
  let streamrChunker: StreamrChunker;

  beforeEach(() => {
    streamrChunker = new StreamrChunker();
  });

  afterEach(async () => {
    await streamrChunker.destroy();
  });

  test('should publish a single message', (done) => {
    const message = { key: 'value' };
    streamrChunker.on('publish', (msg) => {
      expect(msg).toEqual(streamrChunker['wrapRogue'](message));
      expect(msg.b.length).toEqual(2);
      done();
    });
    streamrChunker.publish(message);
  });

  test('should publish a chunked message', (done) => {
    const largeMessage = { key: 'a'.repeat(1200000) };

    streamrChunker.on('publish', (msg) => {
      expect(msg.b.length).toEqual(5);
      done();
    });

    streamrChunker.publish(largeMessage);
  });

  test('should unwrap a rogue message and emit a message event', (done) => {
    const message = { key: 'value' };
    const wrappedMessage = streamrChunker['wrapRogue'](message);

    streamrChunker.on('message', (msg) => {
      expect(msg).toEqual(message);
      done();
    });

    streamrChunker.receiveHandler(wrappedMessage);
  });

  test('should not emit message event for unsupported message when passUnsupportedMessages is not set', () => {
    const unsupportedMessage = 'unsupported';
    const messageSpy = jest.spyOn(streamrChunker, 'emit');
    streamrChunker.receiveHandler(unsupportedMessage);
    expect(messageSpy).not.toHaveBeenCalledWith('message', unsupportedMessage);
  });

  test('should emit message event for unsupported message when passUnsupportedMessages is set', (done) => {
    const unsupportedMessage = 'unsupported';
    streamrChunker.withPassUnsupportedMessages();

    streamrChunker.on('message', (msg) => {
      expect(msg).toEqual(unsupportedMessage);
      done();
    });

    streamrChunker.receiveHandler(unsupportedMessage);
  });

  test('should not emit message event for own message when ignoreOwnMessages is set', () => {
    const message = { key: 'value' };
    const deviceId = 'testDeviceId';
    const wrappedMessage = {
      b: [deviceId, message]
    };
    const messageSpy = jest.spyOn(streamrChunker, 'emit');

    streamrChunker.withIgnoreOwnMessages().withDeviceId(deviceId);
    streamrChunker.receiveHandler(wrappedMessage);

    expect(messageSpy).not.toHaveBeenCalledWith('message', message);
  });

  test('should execute beforeReceiveHook and respect interrupt', () => {
    const message = { key: 'value' };
    const wrappedMessage = streamrChunker['wrapRogue'](message);
    const messageSpy = jest.spyOn(streamrChunker, 'emit');
    const hookFn = jest.fn(() => true);

    streamrChunker.withBeforeReceiveHook(hookFn);
    streamrChunker.receiveHandler(wrappedMessage);

    expect(hookFn).toHaveBeenCalledWith(wrappedMessage);
    expect(messageSpy).not.toHaveBeenCalledWith('message', message);
  });
});
