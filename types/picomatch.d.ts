declare module "picomatch" {
  type PicomatchOptions = {
    dot?: boolean;
    matchBase?: boolean;
    [key: string]: unknown;
  };
  function picomatch(
    patterns: string | string[],
    options?: PicomatchOptions,
  ): (input: string) => boolean;
  namespace picomatch {
    function isMatch(
      input: string,
      patterns: string | string[],
      options?: PicomatchOptions,
    ): boolean;
  }
  export = picomatch;
}
