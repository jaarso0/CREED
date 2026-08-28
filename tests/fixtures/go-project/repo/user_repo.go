package repo

type User struct {
	Name string
	Age  int
}

type UserRepo struct {
	users []User
}

func NewUserRepo() *UserRepo {
	return &UserRepo{}
}

func (r *UserRepo) Insert(name string) error {
	r.users = append(r.users, User{Name: name})
	return nil
}

func (r *UserRepo) count() int {
	return len(r.users)
}
