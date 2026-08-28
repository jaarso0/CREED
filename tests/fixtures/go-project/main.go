package main

import "gofixture/service"

func main() {
	svc := service.NewUserService(nil)
	svc.Save("alice")
}
