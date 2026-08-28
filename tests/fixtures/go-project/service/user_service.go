package service

import (
	"fmt"
	"gofixture/repo"
)

type Notifier interface {
	Notify(message string) error
}

type Handler = func(string) error

const MaxUsers = 100

type UserService struct {
	repo *repo.UserRepo
}

func NewUserService(r *repo.UserRepo) *UserService {
	return &UserService{repo: r}
}

func (s *UserService) Save(name string) error {
	fmt.Println(name)
	return s.repo.Insert(name)
}
