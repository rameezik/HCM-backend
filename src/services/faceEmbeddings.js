const faceProvider = require("./localFaceProvider");

function samplesMatch(embeddings, threshold) {
  for (let first = 0; first < embeddings.length; first++) {
    for (let second = first + 1; second < embeddings.length; second++) {
      if (
        faceProvider.compare(embeddings[first], embeddings[second]) < threshold
      ) {
        return false;
      }
    }
  }
  return true;
}

function averageEmbedding(embeddings) {
  const average = embeddings[0].map(
    (_, dimension) =>
      embeddings.reduce((total, embedding) => total + embedding[dimension], 0) /
      embeddings.length,
  );
  const length = Math.hypot(...average);
  return length < 0.001 ? null : average.map((value) => value / length);
}

module.exports = { samplesMatch, averageEmbedding };
