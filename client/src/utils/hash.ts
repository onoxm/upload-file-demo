import SparkMD5 from "spark-md5";

export const myHash = (buffer: ArrayBuffer): string =>
  SparkMD5.ArrayBuffer.hash(buffer);
