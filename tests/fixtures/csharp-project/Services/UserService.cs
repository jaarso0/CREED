using System;
using Fixture.Data;

namespace Fixture.Services
{
    public class BaseService
    {
        protected void Log(string m) { }
    }

    public class UserService : BaseService, IUserRepo
    {
        private readonly IUserRepo _repo;

        public string Name { get; set; }

        public UserService(IUserRepo repo)
        {
            _repo = repo;
        }

        public void Insert(string name)
        {
            var repo = new UserRepo(10);
            repo.Insert(name);
            Log(name);
        }
    }
}
