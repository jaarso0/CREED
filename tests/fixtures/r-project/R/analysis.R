source("R/utils.R")
library(stats)

summarise_data = function(df) {
  cleaned <- normalize(df)
  stats::median(cleaned)
}

run <- function() {
  summarise_data(c(1, 2, 3))
}
