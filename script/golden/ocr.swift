import AppKit
import Vision

guard CommandLine.arguments.count == 2,
  let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
  FileHandle.standardError.write(Data("usage: swift ocr.swift <png>\n".utf8))
  exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(cgImage: cgImage).perform([request])
for observation in request.results ?? [] {
  if let line = observation.topCandidates(1).first?.string { print(line) }
}
