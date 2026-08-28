library(dplyr)

MAX_ROWS <- 1000

.internal_helper <- function(x) {
  x + 1
}

normalize <- function(values) {
  .internal_helper(values)
}
