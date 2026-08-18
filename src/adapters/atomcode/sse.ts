export class SseParser {
  private buffer = "";

  public push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];

    while (true) {
      const boundary = this.buffer.match(/\r?\n\r?\n/);
      if (!boundary?.index && boundary?.index !== 0) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const payload = this.parseFrame(frame);
      if (payload !== undefined) payloads.push(payload);
    }

    return payloads;
  }

  public finish(): string[] {
    if (!this.buffer) return [];
    const frame = this.buffer;
    this.buffer = "";
    const payload = this.parseFrame(frame);
    return payload === undefined ? [] : [payload];
  }

  private parseFrame(frame: string): string | undefined {
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line === "data") {
        data.push("");
      } else if (line.startsWith("data:")) {
        const value = line.slice(5);
        data.push(value.startsWith(" ") ? value.slice(1) : value);
      }
    }
    return data.length > 0 ? data.join("\n") : undefined;
  }
}
