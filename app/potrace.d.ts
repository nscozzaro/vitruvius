declare module "potrace" {
  interface TraceOptions {
    threshold?: number;
    turdSize?: number;
    optCurve?: boolean;
    alphaMax?: number;
    optTolerance?: number;
    color?: string;
    background?: string;
  }

  function trace(
    file: string | Buffer,
    options: TraceOptions,
    callback: (err: Error | null, svg: string) => void,
  ): void;

  function trace(
    file: string | Buffer,
    callback: (err: Error | null, svg: string) => void,
  ): void;

  function posterize(
    file: string | Buffer,
    options: Record<string, unknown>,
    callback: (err: Error | null, svg: string) => void,
  ): void;
}
